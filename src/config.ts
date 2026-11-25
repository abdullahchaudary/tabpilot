import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The extension's fixed ID, derived from the public "key" in extension/manifest.json.
// Every unpacked install of the official extension gets this same ID.
export const OFFICIAL_EXTENSION_ID = "bhfdplcnlbphflpcffgabmdmnckndojf";

export interface Config {
  /** Shared secret. The extension needs it to pair, MCP clients need it to talk to the daemon. */
  pairingCode: string;
  /** Port for everything: the extension WebSocket (/ext) and MCP over HTTP (/mcp). */
  port: number;
  /** Extra address for the extension WebSocket, for LAN mode (e.g. "0.0.0.0"). null = localhost only. */
  lanHost: string | null;
  /** Hostname allow-list for navigation, e.g. ["localhost", "*.myapp.test"]. Empty = anywhere. */
  allow: string[];
  /** Extension IDs allowed to connect. Add yours here if you fork the extension and change its key. */
  extensionIds: string[];
}

export function homeDir(): string {
  return process.env.TABPILOT_HOME ?? join(homedir(), ".tabpilot");
}

export const paths = {
  config: () => join(homeDir(), "config.json"),
  pid: () => join(homeDir(), "daemon.pid"),
  log: () => join(homeDir(), "daemon.log"),
};

export function newPairingCode(): string {
  // 120 bits, grouped so it survives being read out loud or pasted badly.
  const raw = randomBytes(15).toString("base64url").replace(/[-_]/g, "x");
  return `tp-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
}

const defaults = (): Config => ({
  pairingCode: newPairingCode(),
  port: 7337,
  lanHost: null,
  allow: [],
  extensionIds: [OFFICIAL_EXTENSION_ID],
});

export function loadConfig(): Config {
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const file = paths.config();
  let cfg: Config;
  if (existsSync(file)) cfg = { ...defaults(), ...JSON.parse(readFileSync(file, "utf8")) };
  else saveConfig((cfg = defaults()));
  // Env override is for this process only; saveConfig won't persist it.
  if (process.env.TABPILOT_PORT) cfg.port = Number(process.env.TABPILOT_PORT);
  return cfg;
}

export function saveConfig(cfg: Config): void {
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const out = { ...cfg };
  if (process.env.TABPILOT_PORT && existsSync(paths.config())) out.port = JSON.parse(readFileSync(paths.config(), "utf8")).port ?? 7337;
  writeFileSync(paths.config(), JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  chmodSync(paths.config(), 0o600);
}

export function hostAllowed(cfg: Config, url: string): boolean {
  if (!cfg.allow.length) return true;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol === "about:" || u.protocol === "data:") return true;
    host = u.hostname;
  } catch {
    return false;
  }
  return cfg.allow.some((pattern) => {
    if (pattern.startsWith("*.")) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
    return host === pattern;
  });
}
