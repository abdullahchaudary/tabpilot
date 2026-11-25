import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { Channel, deriveKeys, PROTOCOL_VERSION, randomNonce } from "./wire.js";
import type { Config } from "./config.js";
import { log } from "./log.js";

export interface ConsoleEntry {
  seq: number;
  ts: number;
  level: string;
  text: string;
  source?: string;
}

export interface NetworkEntry {
  seq: number;
  requestId: string;
  ts: number;
  method: string;
  url: string;
  type?: string;
  status?: number;
  mimeType?: string;
  size?: number;
  failed?: string;
  done: boolean;
  durationMs?: number;
  statusText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
}

const CONSOLE_CAP = 1000;
const NETWORK_CAP = 1000;

/** Everything we remember about one tab: its black box recorder. */
export class TabRecorder {
  console: ConsoleEntry[] = [];
  network = new Map<string, NetworkEntry>();
  private seq = 0;

  next(): number {
    return ++this.seq;
  }

  pushConsole(e: Omit<ConsoleEntry, "seq">) {
    this.console.push({ seq: this.next(), ...e });
    if (this.console.length > CONSOLE_CAP) this.console.splice(0, this.console.length - CONSOLE_CAP);
  }

  pushNetwork(e: NetworkEntry) {
    this.network.set(e.requestId, e);
    if (this.network.size > NETWORK_CAP) {
      const oldest = this.network.keys().next().value;
      if (oldest !== undefined) this.network.delete(oldest);
    }
  }
}

function remoteObjectToText(o: any): string {
  if (!o) return "";
  if (o.type === "string") return o.value;
  if (o.unserializableValue) return o.unserializableValue;
  if ("value" in o) return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  if (o.preview?.properties) {
    const props = o.preview.properties.map((p: any) => `${p.name}: ${p.value}`).join(", ");
    return o.subtype === "array" ? `[${props}]` : `${o.className ?? "Object"} {${props}}`;
  }
  return o.description ?? o.type;
}

function shortLocation(url?: string, line?: number): string | undefined {
  if (!url) return undefined;
  const file = url.split("?")[0].split("/").pop() || url;
  return line !== undefined ? `${file}:${line + 1}` : file;
}

/**
 * The daemon's single connection to the browser extension.
 * Requests go out as {id, method, params}; replies come back as {id, result|error};
 * the extension also pushes {event, ...} messages (CDP events, tab closed, debugger detached).
 */
export class Bridge extends EventEmitter {
  private channel: Channel | null = null;
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  readonly recorders = new Map<number, TabRecorder>();
  browserInfo: { userAgent?: string; extensionVersion?: string; connectedAt?: number; remote?: string } = {};
  /** The user hit Pause in the extension. The extension enforces it; we just fail fast and say why. */
  paused = false;
  /** Random id the extension keeps per browser run. A new one means every tab id we know is stale. */
  private instanceId: string | null = null;

  constructor(private cfg: Config) {
    super();
    this.setMaxListeners(100);
  }

  get connected(): boolean {
    return this.channel !== null;
  }

  recorder(tabId: number): TabRecorder {
    let r = this.recorders.get(tabId);
    if (!r) {
      r = new TabRecorder();
      this.recorders.set(tabId, r);
    }
    return r;
  }

  /** Accept a WebSocket from the extension and run the pairing handshake. */
  accept(ws: WebSocket, req: IncomingMessage) {
    const remote = req.socket.remoteAddress ?? "?";
    let stage: "hello" | "auth" | "open" = "hello";
    let clientNonce = "";
    const serverNonce = randomNonce();
    let channel: Channel | null = null;

    const fail = (code: number, reason: string) => {
      log(`extension from ${remote} rejected: ${reason}`);
      try {
        ws.close(code, reason);
      } catch {}
    };

    const handshakeTimer = setTimeout(() => stage !== "open" && fail(4000, "handshake timeout"), 10_000);

    ws.on("message", (data) => {
      onFrame(data.toString()).catch((e) => fail(4000, `handshake error: ${e?.message ?? e}`));
    });

    const onFrame = async (text: string) => {
      if (stage === "hello") {
        let hello: any;
        try {
          hello = JSON.parse(text);
        } catch {}
        if (!hello || typeof hello !== "object" || hello.t !== "hello" || typeof hello.nonce !== "string" || hello.nonce.length > 64) {
          return fail(4000, "bad hello");
        }
        if (hello.v !== PROTOCOL_VERSION) return fail(4002, `protocol mismatch: daemon speaks v${PROTOCOL_VERSION}`);
        clientNonce = hello.nonce;
        stage = "auth"; // before any await, so a second frame can't re-enter this branch
        const keys = await deriveKeys(this.cfg.pairingCode, clientNonce, serverNonce);
        channel = new Channel(
          keys.s2c,
          keys.c2s,
          (frame) => ws.readyState === ws.OPEN && ws.send(frame),
          (msg) => {
            if (stage === "auth") {
              if (msg?.t !== "auth") return fail(4001, "pairing code mismatch");
              stage = "open";
              clearTimeout(handshakeTimer);
              this.adopt(ws, channel!, remote, msg);
              channel!.send({ t: "welcome", daemonVersion: process.env.TABPILOT_VERSION });
            } else {
              this.handle(msg);
            }
          },
          // Can't decrypt: during auth that means a wrong pairing code (sticky in the extension);
          // later it means corruption or tampering (the extension just reconnects).
          () => fail(stage === "auth" ? 4001 : 4004, stage === "auth" ? "pairing code mismatch" : "bad frame"),
        );
        ws.send(JSON.stringify({ t: "challenge", nonce: serverNonce }));
        return;
      }
      if (stage === "auth" && !channel) return; // still deriving keys; the extension won't send before the challenge anyway
      channel?.receive(text);
    };

    ws.on("close", () => {
      clearTimeout(handshakeTimer);
      if (this.socket === ws) this.drop("extension disconnected");
    });
    ws.on("error", () => {});
  }

  private adopt(ws: WebSocket, channel: Channel, remote: string, auth: any) {
    if (this.socket && this.socket !== ws) {
      log("a new extension connection replaced the old one");
      try {
        this.socket.close(4003, "replaced by a newer connection");
      } catch {}
      this.drop("replaced");
    }
    this.socket = ws;
    this.channel = channel;
    if (auth.instanceId !== this.instanceId) {
      // Different browser, or the same browser restarted: tab ids got reused or recycled. Forget them all.
      if (this.instanceId !== null) log("browser instance changed; forgetting old tab state");
      this.recorders.clear();
      this.emit("newBrowser");
      this.instanceId = auth.instanceId ?? null;
    }
    this.browserInfo = { userAgent: auth.userAgent, extensionVersion: auth.version, connectedAt: Date.now(), remote };
    log(`extension paired from ${remote} (${auth.userAgent ?? "unknown browser"})`);
    this.emit("connected");
  }

  private drop(reason: string) {
    this.socket = null;
    this.channel = null;
    this.paused = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Browser disconnected (${reason}).`));
    }
    this.pending.clear();
    this.emit("disconnected");
  }

  private handle(msg: any) {
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      return;
    }
    if (msg.t === "ping") return;
    switch (msg.event) {
      case "cdp":
        this.record(msg.tabId, msg.method, msg.params);
        this.emit("cdp", msg.tabId, msg.method, msg.params);
        break;
      case "paused":
        this.paused = !!msg.paused;
        log(this.paused ? "user paused the AI" : "user resumed the AI");
        this.emit("paused", this.paused);
        break;
      case "detached":
        this.emit("detached", msg.tabId, msg.reason);
        break;
      case "tabRemoved":
        this.recorders.delete(msg.tabId);
        this.emit("tabRemoved", msg.tabId);
        break;
    }
  }

  /** Feed CDP events into the tab's black box. */
  private record(tabId: number, method: string, p: any) {
    const r = this.recorder(tabId);
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const frame = p.stackTrace?.callFrames?.[0];
        const level = p.type === "warning" ? "warn" : p.type;
        r.pushConsole({ ts: Date.now(), level, text: (p.args ?? []).map(remoteObjectToText).join(" "), source: shortLocation(frame?.url, frame?.lineNumber) });
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails ?? {};
        const text = d.exception?.description ?? d.text ?? "Uncaught exception";
        r.pushConsole({ ts: Date.now(), level: "error", text, source: shortLocation(d.url, d.lineNumber) });
        break;
      }
      case "Log.entryAdded": {
        const e = p.entry ?? {};
        const level = e.level === "warning" ? "warn" : e.level === "verbose" ? "debug" : e.level;
        r.pushConsole({ ts: Date.now(), level, text: `[${e.source}] ${e.text}`, source: shortLocation(e.url, e.lineNumber) });
        break;
      }
      case "Page.frameNavigated":
        if (!p.frame?.parentId) r.pushConsole({ ts: Date.now(), level: "nav", text: `navigated to ${p.frame.url}` });
        break;
      case "Network.requestWillBeSent": {
        const prev = r.network.get(p.requestId);
        // Redirects reuse the requestId; keep the latest hop.
        r.pushNetwork({
          seq: prev?.seq ?? r.next(),
          requestId: p.requestId,
          ts: Date.now(),
          method: p.request.method,
          url: p.request.url,
          type: p.type,
          done: false,
          requestHeaders: p.request.headers,
          postData: p.request.postData,
          hasPostData: p.request.hasPostData,
        });
        break;
      }
      case "Network.responseReceived": {
        const e = r.network.get(p.requestId);
        if (e) {
          e.status = p.response.status;
          e.mimeType = p.response.mimeType;
          e.statusText = p.response.statusText;
          e.responseHeaders = p.response.headers;
          e.type = p.type ?? e.type;
        }
        break;
      }
      case "Network.loadingFinished": {
        const e = r.network.get(p.requestId);
        if (e) {
          e.done = true;
          e.size = p.encodedDataLength;
          e.durationMs = Date.now() - e.ts;
        }
        break;
      }
      case "Network.loadingFailed": {
        const e = r.network.get(p.requestId);
        if (e) {
          e.done = true;
          e.failed = p.canceled ? "canceled" : p.blockedReason ? `blocked: ${p.blockedReason}` : p.errorText;
          e.durationMs = Date.now() - e.ts;
        }
        break;
      }
    }
  }

  /** Send a command to the extension and wait for the answer. */
  call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const channel = this.channel;
    if (!channel) {
      return Promise.reject(
        new Error(
          "No browser connected. Open the tabpilot extension popup, paste the pairing code from `tabpilot pair`, and hit Connect.",
        ),
      );
    }
    if (this.paused && method !== "debugger.detach") {
      return Promise.reject(
        new Error("⏸ The user paused tabpilot from the browser. Stop here and wait for them to resume it (or ask them what's up). Don't retry in a loop."),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const secs = Math.round(timeoutMs / 1000);
        const what = method === "cdp" ? String(params.method) : method;
        reject(
          new Error(
            what === "Page.navigate"
              ? `The site didn't respond within ${secs}s (Chrome is still waiting for it). Is the server running and reachable from the browser's machine?`
              : `Chrome didn't finish ${what} within ${secs}s. The page may be hung, stuck loading, or busy; try navigate with action "reload", or check the console.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      channel.send({ id, method, params });
    });
  }

  /**
   * Wait for the first CDP event on a tab that `match` returns a value for. Returns the promise plus a cancel()
   * so callers never leave listeners behind. Call before triggering the thing that fires it.
   */
  waitFor<T>(tabId: number, match: (method: string, params: any) => T | undefined, timeoutMs: number) {
    let cancel: () => void = () => {};
    const promise = new Promise<T | "timeout">((resolve) => {
      const onEvent = (t: number, m: string, p: any) => {
        if (t !== tabId) return;
        const v = match(m, p);
        if (v !== undefined) {
          cancel();
          resolve(v);
        }
      };
      const onGone = () => {
        cancel();
        resolve("timeout");
      };
      const timer = setTimeout(onGone, timeoutMs);
      cancel = () => {
        clearTimeout(timer);
        this.off("cdp", onEvent);
        this.off("disconnected", onGone);
      };
      this.on("cdp", onEvent);
      this.on("disconnected", onGone);
    });
    return { promise, cancel: () => cancel() };
  }
}
