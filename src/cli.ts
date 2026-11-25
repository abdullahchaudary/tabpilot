#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { loadConfig, newPairingCode, paths, saveConfig } from "./config.js";
import { genericSnippets, install } from "./install.js";
import { daemonHealth, ensureDaemon } from "./shim.js";
import { VERSION } from "./version.js";

const HELP = `
  ✈  tabpilot v${VERSION}
     let your AI fly your browser.

  usage: tabpilot <command>

  setup
    install [--only a,b] [--claude-dir DIR]...   wire tabpilot into Claude Code (every profile), Claude Desktop,
                                                 Cursor, Windsurf, Codex. --dry-run to preview, --uninstall to undo
    config                                       print config for any other MCP client (Hermes, OpenClaw, Zed...)
    pair                                         show the pairing code + address for the extension

  daemon
    start [--lan [host]]   start the daemon in the background (MCP clients do this for you)
    stop                   stop it
    restart                stop + start (after updating tabpilot)
    status                 is it running, is a browser paired
    daemon [--lan [host]]  run it in the foreground (logs to your terminal)
    lan <host|off>         make LAN mode permanent (e.g. \`tabpilot lan 0.0.0.0\`)
    rotate                 new pairing code (you'll re-pair the extension)

  mcp                      the stdio MCP server; this is what your MCP client launches

  docs: https://github.com/abdullahchaudary/tabpilot
`;

function flag(args: string[], name: string): string | true | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const next = args[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);
}

async function stop(): Promise<boolean> {
  if (!existsSync(paths.pid())) return false;
  const pid = Number(readFileSync(paths.pid(), "utf8"));
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    unlinkSync(paths.pid());
    return false;
  }
  for (let i = 0; i < 100 && (await daemonHealth(loadConfig())); i++) await new Promise((r) => setTimeout(r, 100));
  return true;
}

async function main() {
  const [cmd = "help", ...args] = process.argv.slice(2);
  const cfg = loadConfig();

  switch (cmd) {
    case "mcp": {
      const { runShim } = await import("./shim.js");
      return runShim();
    }

    case "daemon": {
      const lan = flag(args, "--lan");
      const port = flag(args, "--port");
      const { runDaemon } = await import("./daemon.js");
      return runDaemon({ lanHost: lan === true ? "0.0.0.0" : lan, port: typeof port === "string" ? Number(port) : undefined });
    }

    case "start": {
      const lan = flag(args, "--lan");
      if (lan) {
        cfg.lanHost = lan === true ? "0.0.0.0" : lan;
        saveConfig(cfg);
      }
      if (await daemonHealth(cfg)) return console.log("✓ already running. `tabpilot status` for details.");
      await ensureDaemon(cfg);
      return console.log(`✓ daemon up on port ${cfg.port}${cfg.lanHost ? ` (LAN mode: ${cfg.lanHost})` : ""}. Logs: ${paths.log()}`);
    }

    case "stop":
      return console.log((await stop()) ? "✓ daemon stopped. Wheels down." : "Daemon wasn't running.");

    case "restart":
      await stop();
      await ensureDaemon(cfg);
      return console.log("✓ daemon restarted.");

    case "status": {
      const h = await daemonHealth(cfg);
      if (!h) return console.log(`✗ daemon not running. \`tabpilot start\` (or just use it from Claude, it starts itself).`);
      console.log(`✓ daemon v${h.version} on port ${cfg.port}${cfg.lanHost ? `, LAN mode on ${cfg.lanHost}` : ""}`);
      console.log(h.browser ? "✓ browser paired and connected" : "✗ no browser connected (run `tabpilot pair`)");
      console.log(`  ${h.sessions} MCP session(s) flying`);
      return;
    }

    case "pair": {
      const h = await daemonHealth(cfg);
      console.log(`
  pairing code   ${cfg.pairingCode}

  in the extension popup, use:
    server  ws://127.0.0.1:${cfg.port}/ext      (same machine, or through an SSH tunnel)`);
      if (cfg.lanHost) for (const ip of lanAddresses()) console.log(`            ws://${ip}:${cfg.port}/ext`);
      console.log(`
  daemon ${h ? "is running ✓" : "isn't running yet: `tabpilot start` (or use any tabpilot tool from Claude)"}
  remote browser? see docs/remote.md (SSH tunnel is a one-liner)
`);
      return;
    }

    case "rotate": {
      cfg.pairingCode = newPairingCode();
      saveConfig(cfg);
      const wasRunning = await stop();
      if (wasRunning) await ensureDaemon(cfg);
      console.log(`✓ new pairing code: ${cfg.pairingCode}\n  Re-pair the extension. HTTP MCP clients need the new code too; stdio clients pick it up automatically.`);
      return;
    }

    case "lan": {
      const v = args[0];
      if (!v) return console.log(`LAN mode is ${cfg.lanHost ? `on (${cfg.lanHost})` : "off"}. \`tabpilot lan 0.0.0.0\` or \`tabpilot lan off\`.`);
      cfg.lanHost = v === "off" ? null : v;
      saveConfig(cfg);
      if (await stop()) await ensureDaemon(cfg);
      return console.log(cfg.lanHost ? `✓ LAN mode on (${cfg.lanHost}). \`tabpilot pair\` shows the addresses.` : "✓ LAN mode off. Localhost only.");
    }

    case "install": {
      const only = flag(args, "--only");
      const claudeDirs: string[] = [];
      args.forEach((a, i) => a === "--claude-dir" && args[i + 1] && claudeDirs.push(args[i + 1]));
      const { results, skip } = install({
        only: typeof only === "string" ? only.split(",") : undefined,
        dryRun: args.includes("--dry-run"),
        uninstall: args.includes("--uninstall"),
        claudeDirs,
      });
      console.log("\n" + (results.length ? results.map((r) => "  " + r).join("\n") : "  Nothing configured."));
      if (skip.length) console.log("\n  skipped: " + skip.join(", "));
      if (!args.includes("--uninstall")) {
        console.log(`\n  Restart those apps (or start a new Claude Code session) to pick it up.
  Other clients? \`tabpilot config\` prints copy-paste config.
  Next: load the extension and pair it. \`tabpilot pair\` has your code.\n`);
      }
      return;
    }

    case "config":
      return console.log(genericSnippets());

    case "-v":
    case "--version":
    case "version":
      return console.log(VERSION);

    case "help":
    case "-h":
    case "--help":
      return console.log(HELP);

    default:
      console.error(`Unknown command "${cmd}".`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`✗ ${e?.message ?? e}`);
  process.exit(1);
});
