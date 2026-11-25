# other pilots

tabpilot is a normal MCP server, so anything that speaks MCP can fly it. there are two ways to plug in.

## stdio (works almost everywhere)

your client launches `tabpilot mcp` and talks over stdin/stdout. the shim starts the daemon if it isn't running.

```bash
tabpilot config      # prints the exact command + args for your machine
```

it uses absolute paths, because GUI apps don't inherit your shell's `PATH`. looks something like:

```json
{
  "mcpServers": {
    "tabpilot": {
      "command": "/usr/local/bin/node",
      "args": ["/home/you/tabpilot/dist/cli.js", "mcp"]
    }
  }
}
```

if you ran `npm link`, plain `"command": "tabpilot", "args": ["mcp"]` works too, as long as `tabpilot` is on that app's `PATH`.

## streamable HTTP (for clients that take a URL)

```
url:     http://127.0.0.1:7337/mcp
header:  Authorization: Bearer <your pairing code>
```

the daemon has to be running for this (`tabpilot start`), since nothing's there to launch it. localhost only.

---

## auto-configured by `tabpilot install`

| client | where it writes |
|---|---|
| Claude Code | `claude mcp add --scope user` for every profile it finds |
| Claude Desktop | `claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Codex CLI | `[mcp_servers.tabpilot]` in `~/.codex/config.toml` |

only pick some: `tabpilot install --only claude-code,cursor`. undo: `tabpilot install --uninstall`.

### Claude Code profiles

"profile" here means a separate Claude Code config dir, the thing you get with `CLAUDE_CONFIG_DIR=~/.claude-work claude`. `tabpilot install` finds:

- the default profile (`~/.claude` / `~/.claude.json`)
- whatever `CLAUDE_CONFIG_DIR` is set to right now
- any `~/.claude-*` or `~/.claude_*` folder that looks like a config dir

and adds tabpilot to each one at user scope. missing one? `tabpilot install --claude-dir /path/to/profile` (repeat it for more).

doing it by hand:

```bash
CLAUDE_CONFIG_DIR=~/.claude-work claude mcp add --scope user tabpilot -- tabpilot mcp
```

---

## everything else

these aren't auto-configured. here's the gist, but check your client's docs for exactly where MCP servers go, because they change faster than this page.

- **Hermes Agent**: MCP servers go in its config file. add a `tabpilot` server with the command + args from `tabpilot config`
- **OpenClaw** (formerly Clawdbot): reaches MCP servers through `mcporter`. register tabpilot there as a stdio server with the same command + args
- **VS Code (Copilot agent mode)**: add it to `.vscode/mcp.json` or your user MCP settings as a stdio server
- **Zed, Cline, Continue, Goose, ...**: same deal, a stdio server with the command + args
- **your own agent**: use any MCP SDK. stdio via `tabpilot mcp`, or HTTP at `/mcp` with the bearer header

got one working that isn't listed? PRs to this page are very welcome.

## many clients at once

go for it. Claude Code in three terminals, Cursor, and a Codex run can all use tabpilot at the same time. they share one daemon and one browser, each session gets its own tab group, and they can see (and grab) each other's tabs with `tabs_list` / `tab_select`.
