import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

interface Options {
  only?: string[];
  dryRun?: boolean;
  uninstall?: boolean;
  claudeDirs?: string[];
}

/** The exact command MCP clients should launch. Absolute paths, because GUI apps don't share your shell's PATH. */
export function launchCommand() {
  return { command: process.execPath, args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "mcp"] };
}

const home = homedir();

function which(bin: string): boolean {
  return spawnSync(platform() === "win32" ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;
}

/** Every Claude Code profile we can find: the default one, CLAUDE_CONFIG_DIR, and ~/.claude-* style dirs. */
export function claudeProfiles(extra: string[] = []): Array<string | null> {
  const found = new Set<string>();
  const profiles: Array<string | null> = [];
  if (existsSync(join(home, ".claude")) || existsSync(join(home, ".claude.json"))) profiles.push(null); // default profile
  const candidates = [...extra, process.env.CLAUDE_CONFIG_DIR ?? ""];
  for (const name of readdirSync(home)) {
    if (/^\.claude[-_.].+/.test(name) && name !== ".claude.json" && !name.endsWith(".json") && !name.endsWith(".backup")) candidates.push(join(home, name));
  }
  for (const dir of candidates) {
    if (!dir || found.has(dir) || dir === join(home, ".claude")) continue;
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    // Only real config dirs: they have settings or a .claude.json from a previous login.
    if (!["settings.json", ".claude.json", "projects", ".credentials.json"].some((f) => existsSync(join(dir, f)))) continue;
    found.add(dir);
    profiles.push(dir);
  }
  return profiles;
}

function editJson(file: string, mutate: (doc: any) => void, dryRun?: boolean) {
  const doc = existsSync(file) ? JSON.parse(readFileSync(file, "utf8") || "{}") : {};
  mutate(doc);
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  }
}

function claudeDesktopConfig(): string {
  if (platform() === "darwin") return join(home, "Library/Application Support/Claude/claude_desktop_config.json");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(home, "AppData/Roaming"), "Claude/claude_desktop_config.json");
  return join(home, ".config/Claude/claude_desktop_config.json");
}

export function install(opts: Options = {}) {
  const { command, args } = launchCommand();
  const want = (name: string) => !opts.only || opts.only.includes(name);
  const verb = opts.uninstall ? "removed from" : "added to";
  const results: string[] = [];
  const skip: string[] = [];

  // ---- Claude Code: one entry per profile, user scope so every project sees it.
  if (want("claude-code")) {
    if (!which("claude")) skip.push("claude-code (no `claude` on PATH)");
    else {
      for (const dir of claudeProfiles(opts.claudeDirs)) {
        const env = { ...process.env };
        if (dir) env.CLAUDE_CONFIG_DIR = dir;
        else delete env.CLAUDE_CONFIG_DIR;
        const label = dir ? `Claude Code profile ${dir.replace(home, "~")}` : "Claude Code (default profile)";
        if (opts.dryRun) {
          results.push(`would update ${label}`);
          continue;
        }
        spawnSync("claude", ["mcp", "remove", "--scope", "user", "tabpilot"], { env, stdio: "ignore" });
        if (!opts.uninstall) {
          try {
            execFileSync("claude", ["mcp", "add", "--scope", "user", "tabpilot", "--", command, ...args], { env, stdio: "pipe" });
          } catch (e: any) {
            results.push(`✗ ${label}: ${String(e.stderr ?? e.message).trim()}`);
            continue;
          }
        }
        results.push(`✓ ${verb} ${label}`);
      }
    }
  }

  // ---- JSON-config clients that share the { mcpServers: { name: {command, args} } } shape.
  const jsonClients: Array<[string, string, string]> = [
    ["claude-desktop", "Claude Desktop", claudeDesktopConfig()],
    ["cursor", "Cursor", join(home, ".cursor/mcp.json")],
    ["windsurf", "Windsurf", join(home, ".codeium/windsurf/mcp_config.json")],
  ];
  for (const [key, label, file] of jsonClients) {
    if (!want(key)) continue;
    if (!existsSync(dirname(file))) {
      skip.push(`${key} (not installed)`);
      continue;
    }
    editJson(
      file,
      (doc) => {
        doc.mcpServers ??= {};
        if (opts.uninstall) delete doc.mcpServers.tabpilot;
        else doc.mcpServers.tabpilot = { command, args };
      },
      opts.dryRun,
    );
    results.push(`${opts.dryRun ? "would update" : `✓ ${verb}`} ${label} (${file.replace(home, "~")})`);
  }

  // ---- Codex CLI: TOML. We own the [mcp_servers.tabpilot] block and nothing else.
  if (want("codex")) {
    const file = join(home, ".codex/config.toml");
    if (!existsSync(dirname(file))) skip.push("codex (not installed)");
    else {
      let toml = existsSync(file) ? readFileSync(file, "utf8") : "";
      toml = toml.replace(/\n?\[mcp_servers\.tabpilot\][\s\S]*?(?=\n\[|$)/, "");
      if (!opts.uninstall) toml = toml.trimEnd() + `\n\n[mcp_servers.tabpilot]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`;
      if (!opts.dryRun) writeFileSync(file, toml.trimStart());
      results.push(`${opts.dryRun ? "would update" : `✓ ${verb}`} Codex (${file.replace(home, "~")})`);
    }
  }

  return { results, skip };
}

/** Copy-paste config for anything we don't auto-configure (Hermes, OpenClaw via mcporter, Zed, Cline, your own agent...). */
export function genericSnippets(): string {
  const { command, args } = launchCommand();
  const cfg = loadConfig();
  return `stdio (works almost everywhere):
  command: ${command}
  args:    ${JSON.stringify(args)}

  as JSON:
  ${JSON.stringify({ mcpServers: { tabpilot: { command, args } } })}

streamable HTTP (for clients that take a URL; the daemon must be running: \`tabpilot start\`):
  url:     http://127.0.0.1:${cfg.port}/mcp
  header:  Authorization: Bearer ${cfg.pairingCode}`;
}
