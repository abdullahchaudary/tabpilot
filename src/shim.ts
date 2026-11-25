import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, paths, type Config } from "./config.js";
import { log } from "./log.js";
import { VERSION } from "./version.js";

export async function daemonHealth(cfg: Config): Promise<{ name: string; version: string; browser: boolean; sessions: number } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = await r.json();
    return body?.name === "tabpilot" ? body : null;
  } catch {
    return null;
  }
}

/** Start the daemon in the background if it isn't already up. Returns once /health answers. */
export async function ensureDaemon(cfg: Config): Promise<void> {
  const health = await daemonHealth(cfg);
  if (health) {
    if (health.version !== VERSION) log(`heads up: running daemon is v${health.version}, this is v${VERSION}. Run \`tabpilot restart\` to update it.`);
    return;
  }
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const out = openSync(paths.log(), "a");
  const child = spawn(process.execPath, [cli, "daemon"], { detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await daemonHealth(cfg)) return;
  }
  throw new Error(`The tabpilot daemon didn't come up. Check ${paths.log()}.`);
}

/**
 * stdio MCP server that forwards everything to the daemon's HTTP MCP endpoint.
 * This is what MCP clients launch. Many of these can run at once; they all share one daemon and one browser.
 */
export async function runShim() {
  let cfg = loadConfig();
  await ensureDaemon(cfg);

  let client: Client | null = null;
  let transport: StreamableHTTPClientTransport | null = null;

  const connect = async () => {
    cfg = loadConfig(); // re-read so `tabpilot rotate` doesn't strand running sessions
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${cfg.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${cfg.pairingCode}` } },
    });
    const c = new Client({ name: "tabpilot-shim", version: VERSION });
    await c.connect(transport);
    client = c;
    return c;
  };

  // If the daemon restarted under us, our HTTP session is gone. Reconnect once and retry.
  const withClient = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    try {
      return await fn(client ?? (await connect()));
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!/session not found|fetch failed|ECONNREFUSED|404|401|pairing code/i.test(msg)) throw e;
      client = null;
      await ensureDaemon(cfg);
      return fn(await connect());
    }
  };

  const first = await connect();
  const server = new Server(
    { name: "tabpilot", version: VERSION },
    { capabilities: { tools: {} }, instructions: first.getInstructions() },
  );
  server.setRequestHandler(ListToolsRequestSchema, (req) => withClient((c) => c.listTools(req.params)));
  server.setRequestHandler(CallToolRequestSchema, (req) => withClient((c) => c.callTool(req.params, undefined, { timeout: 180_000 })) as any);

  const stdio = new StdioServerTransport();
  const goodbye = async () => {
    await transport?.terminateSession().catch(() => {});
    process.exit(0);
  };
  stdio.onclose = goodbye;
  process.stdin.on("end", goodbye);
  process.on("SIGTERM", goodbye);
  process.on("SIGINT", goodbye);
  await server.connect(stdio);
}
