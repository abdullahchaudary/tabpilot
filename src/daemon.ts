import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import { Bridge } from "./bridge.js";
import { loadConfig, paths, type Config } from "./config.js";
import { log } from "./log.js";
import { Pilot, Session } from "./pilot.js";
import { createMcpServer } from "./tools.js";
import { VERSION } from "./version.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sameSecret(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface DaemonOptions {
  lanHost?: string | null;
  port?: number;
}

export async function runDaemon(opts: DaemonOptions = {}) {
  // One bad request or a bug in a handler must never take down every session and the browser link.
  process.on("unhandledRejection", (e: any) => log(`unhandled rejection: ${e?.stack ?? e}`));
  process.on("uncaughtException", (e: any) => log(`uncaught exception: ${e?.stack ?? e}`));
  const cfg: Config = loadConfig();
  if (opts.port) cfg.port = opts.port;
  if (opts.lanHost !== undefined) cfg.lanHost = opts.lanHost;

  const bridge = new Bridge(cfg);
  const pilot = new Pilot(bridge, cfg);
  const mcpSessions = new Map<string, { transport: StreamableHTTPServerTransport; session: Session; lastSeen: number }>();
  // A client killed without saying goodbye leaves its session behind. Expire quiet ones; a live shim
  // that comes back later gets "session not found" and transparently starts a new one (same tab group).
  const SESSION_IDLE_MS = 60 * 60_000;
  setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const m of mcpSessions.values()) {
      if (m.lastSeen >= cutoff) continue;
      m.session.expired = true;
      m.transport.close().catch(() => {});
    }
  }, 5 * 60_000).unref();
  const okHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, `[::1]:${cfg.port}`]);

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    // MCP is local-only, whatever the LAN setting. The LAN only ever gets the encrypted extension socket.
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return json(res, 403, { error: "MCP is only served to localhost" });
    // DNS-rebinding guard: a web page can't make the browser send a Host header of 127.0.0.1:port from evil.com.
    if (!okHosts.has(req.headers.host ?? "")) return json(res, 403, { error: "bad Host header" });
    const auth = req.headers.authorization ?? "";
    if (!sameSecret(auth, `Bearer ${cfg.pairingCode}`)) return json(res, 401, { error: "missing or wrong pairing code (Authorization: Bearer <code>)" });

    const sid = req.headers["mcp-session-id"];
    const existing = typeof sid === "string" ? mcpSessions.get(sid) : undefined;
    if (existing) {
      existing.lastSeen = Date.now();
      return existing.transport.handleRequest(req, res);
    }
    if (sid) return json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
    if (req.method !== "POST") return json(res, 400, { error: "start a session with an initialize POST" });

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: "invalid JSON" });
    }
    if (!isInitializeRequest(body)) return json(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Expected initialize" }, id: null });

    // One McpServer per client session. It has to be connected before the initialize request is handled,
    // so the session gets its id a moment later, when the transport mints it.
    // The shim sends a stable per-process key so the session can find its tab again after reconnects.
    const keyHeader = req.headers["x-tabpilot-client"];
    const key = typeof keyHeader === "string" && /^[A-Za-z0-9-]{8,64}$/.test(keyHeader) ? keyHeader : randomUUID();
    const session = new Session(key);
    const server = createMcpServer(pilot, session);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        pilot.sessions.set(id, session);
        mcpSessions.set(id, { transport, session, lastSeen: Date.now() });
        log(`session ${session.label} took off (${mcpSessions.size} flying)`);
      },
    });
    transport.onclose = () => {
      if (!session.id) return;
      mcpSessions.delete(session.id);
      pilot.closeSession(session).catch(() => {});
      server.close().catch(() => {});
      log(`session ${session.label} landed (${mcpSessions.size} flying)`);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
      return json(res, 200, { name: "tabpilot", version: VERSION, browser: bridge.connected, sessions: mcpSessions.size, pid: process.pid });
    }
    if (path === "/mcp") {
      handleMcp(req, res).catch((e) => {
        log(`mcp error: ${e?.stack ?? e}`);
        if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) });
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("tabpilot daemon. Nothing to see here; point the extension at /ext and MCP clients at /mcp.\n");
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const allowedOrigins = new Set(cfg.extensionIds.map((id) => `chrome-extension://${id}`));
  const onUpgrade = (req: IncomingMessage, socket: any, head: Buffer) => {
    const path = (req.url ?? "/").split("?")[0];
    const origin = req.headers.origin ?? "";
    if (path !== "/ext" || !allowedOrigins.has(origin)) {
      log(`refused websocket from ${req.socket.remoteAddress} (origin ${origin || "none"})`);
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => bridge.accept(ws, req));
  };

  // Always listen on loopback. LAN mode adds a second listener (or one wildcard listener).
  const hosts = !cfg.lanHost ? ["127.0.0.1"] : ["0.0.0.0", "::"].includes(cfg.lanHost) ? [cfg.lanHost] : ["127.0.0.1", cfg.lanHost];
  const servers: Server[] = [];
  const up: string[] = [];
  for (const host of hosts) {
    const isLan = host !== "127.0.0.1";
    const srv = createServer(handler);
    srv.on("upgrade", onUpgrade);
    const outcome = await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(cfg.port, host, () => resolve());
    }).catch(async (e: any) => {
      if (e.code === "EADDRINUSE") {
        const running = await fetch(`http://127.0.0.1:${cfg.port}/health`).then((r) => r.json()).catch(() => null);
        if (running?.name === "tabpilot") {
          log(`a tabpilot daemon (v${running.version}) is already running on port ${cfg.port}. Nothing to do.`);
          process.exit(0);
        }
        log(`port ${cfg.port} is taken by something else. Set "port" in ${paths.config()} or TABPILOT_PORT.`);
        process.exit(1);
      }
      // The LAN address isn't there (Tailscale not up yet, DHCP gave us a new IP...). Local use still works.
      if (isLan && hosts.includes("127.0.0.1")) {
        log(`couldn't listen on ${host}:${cfg.port} (${e.code ?? e.message}). LAN mode is off for now; local connections still work. Fix the address with \`tabpilot lan <ip>\` and restart.`);
        return "skip";
      }
      throw e;
    });
    if (outcome === "skip") continue;
    servers.push(srv);
    up.push(host);
  }

  writeFileSync(paths.pid(), String(process.pid));
  log(`daemon v${VERSION} up on ${up.map((h) => `${h.includes(":") ? `[${h}]` : h}:${cfg.port}`).join(" + ")}`);
  if (cfg.lanHost && up.some((h) => h !== "127.0.0.1")) log(`LAN mode: extensions can connect at ws://<this machine's IP>:${cfg.port}/ext (encrypted, pairing code required)`);

  const shutdown = () => {
    log("shutting down");
    try {
      if (existsSync(paths.pid()) && readFileSync(paths.pid(), "utf8") === String(process.pid)) unlinkSync(paths.pid());
    } catch {}
    for (const s of servers) s.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
