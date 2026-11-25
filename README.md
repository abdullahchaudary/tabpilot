<p align="center">
  <img src="docs/assets/logo.svg" width="96" alt="tabpilot logo" />
</p>

<h1 align="center">tabpilot</h1>

<p align="center"><b>let your AI fly your browser.</b><br/>
an MCP server + browser extension that hands Claude Code (or any MCP client) the controls of your <i>real</i> browser. clicks, typing, screenshots, console, network, the whole cockpit.</p>

---

so you're building an app with Claude. it writes the code, runs the tests, and then... asks you to go check if the button actually works. you alt-tab, click around, open devtools, copy the error, paste it back. over and over.

nah. tabpilot gives Claude the stick. it opens your app in your actual browser, clicks through it like a user would, reads the console and network tab, sees what broke, and fixes it. you just watch it fly.

- 🛫 **your real browser.** your Chrome/Edge/Brave, your profile, your logins. no headless robot browser with its own sandbox you gotta babysit.
- 🔎 **full debug access.** console logs, uncaught errors, CSP/CORS warnings, every network request with headers and bodies, plus raw Chrome DevTools Protocol if you want to get weird.
- 🧑‍✈️ **many pilots, one plane.** run 5 Claude sessions at once and they all share one browser without fighting. each session gets its own color-coded tab group.
- 🌍 **remote-friendly.** Claude on a server, browser on your laptop? one SSH command. or LAN mode with end-to-end encryption. no cloud relay, no accounts, no servers we run.
- 🔌 **works with any MCP client.** Claude Code (every profile), Claude Desktop, Cursor, Windsurf, Codex, Hermes, OpenClaw, your own agent. if it speaks MCP, it can fly.

## preflight checklist

you need **Node 20+** and a Chromium browser (Chrome, Edge, Brave, Arc, Vivaldi...). this one isn't on npm or the Chrome Web Store. you build it yourself, it takes about a minute.

### 1. grab it and build it

```bash
git clone https://github.com/abdullahchaudary/tabpilot.git
cd tabpilot
npm install          # also builds it
npm link             # optional, puts `tabpilot` on your PATH
```

no `npm link`? swap `tabpilot` for `node dist/cli.js` in everything below.

### 2. hook it up to your AI

```bash
tabpilot install
```

that finds every MCP client on your machine and adds tabpilot to each one:

- **Claude Code**: every profile it can find (`~/.claude`, `~/.claude-work`, whatever `CLAUDE_CONFIG_DIR` points at), at user scope, so every project gets it
- **Claude Desktop**, **Cursor**, **Windsurf**, **Codex**: if they're installed

wanna see what it'll touch first? `tabpilot install --dry-run`. got a profile somewhere weird? `--claude-dir /path/to/it`. using something else? `tabpilot config` prints copy-paste config, and [docs/clients.md](docs/clients.md) has the rest.

### 3. load the extension

1. open `chrome://extensions` (or `edge://extensions`, `brave://extensions`)
2. flip on **Developer mode** (top right)
3. hit **Load unpacked** and pick the `extension` folder inside your tabpilot clone
4. pin the little paper plane so you can see its status light

### 4. pair it

```bash
tabpilot pair
```

copy the pairing code, click the extension icon, paste it, hit **Connect**. the light goes green and the badge says `ON`. you're cleared for takeoff.

### 5. fly

open a new Claude Code session and just ask:

> open localhost:3000, sign up with a test account, and tell me if anything errors in the console

> the checkout button does nothing. go figure out why.

> screenshot the landing page at iPhone size and at desktop size and compare them

Claude picks up the tools on its own. the daemon starts itself the first time a tool gets used.

## what Claude can do

| | tools |
|---|---|
| **tabs** | `tabs_list` `tab_open` `tab_select` `tab_close` |
| **getting around** | `navigate` (url, back, forward, reload, hard-reload) |
| **eyes** | `snapshot` (page structure + refs, cheap) and `screenshot` (viewport, full page, or one element) |
| **hands** | `click` `hover` `type` `press` `select_option` `scroll` `wait_for` |
| **black box** | `console` `network` `network_detail` |
| **power tools** | `evaluate` (run JS in the page), `viewport` (responsive testing), `cdp` (raw DevTools Protocol) |
| **cockpit** | `status` |

the full manual is in [docs/tools.md](docs/tools.md).

## how it works (the 10-second version)

```
 Claude Code ─┐                                         ┌──────────────────────┐
 Cursor ──────┼─ stdio ─► tabpilot ─ HTTP ─► daemon ◄── │  tabpilot extension  │
 Codex ───────┘           (shim)             :7337  ws  │  chrome.debugger/CDP │
                                                   enc. └──────────────────────┘
```

one little daemon runs on your machine. every MCP client talks to it, and the extension dials into it over an encrypted WebSocket. the extension does the browser stuff with `chrome.debugger`, which is the same protocol DevTools itself uses. more in [docs/architecture.md](docs/architecture.md).

## flying long-haul (remote)

Claude on a dev server, browser on your laptop? the easy way, from your laptop:

```bash
ssh -L 7337:127.0.0.1:7337 you@devbox
```

leave that open, and the extension connects to `ws://127.0.0.1:7337/ext` like it's all local. that's it. LAN mode and Tailscale are in [docs/remote.md](docs/remote.md).

## cabin safety

this thing can drive a logged-in browser, so it's locked down by default:

- the daemon only listens on localhost unless you say otherwise
- the extension has to pair with a 120-bit code. it's never sent over the wire, both sides prove they have it
- everything between the extension and the daemon is encrypted (AES-256-GCM), even on localhost
- only the tabpilot extension can connect. web pages get bounced
- the MCP endpoint is localhost-only, *always*, even in LAN mode
- Chrome shows a "tabpilot started debugging this browser" bar whenever it's attached. hit **Cancel** and you've got the controls back, and Claude won't grab that tab again without asking
- big red **MAYDAY** button in the popup lets go of every tab and hangs up
- optional allow-list so it only goes to the sites you want

real talk: use a separate browser profile for agent stuff if your main one is logged into your bank. the full rundown is in [docs/security.md](docs/security.md).

## the CLI

```
tabpilot install     wire it into your MCP clients (--dry-run, --uninstall, --only, --claude-dir)
tabpilot pair        show the pairing code + addresses
tabpilot status      is the daemon up, is a browser connected
tabpilot start       start the daemon (MCP clients do this for you)
tabpilot stop        stop it
tabpilot restart     after you pull updates
tabpilot lan <host>  LAN mode on (tabpilot lan off to turn it off)
tabpilot rotate      new pairing code
tabpilot config      config snippets for any other MCP client
```

## something broke?

[docs/troubleshooting.md](docs/troubleshooting.md), aka the mayday page.

## updating

```bash
cd tabpilot && git pull && npm install && tabpilot restart
```

then hit the reload icon on the extension in `chrome://extensions`.

## hacking on it

[CONTRIBUTING.md](CONTRIBUTING.md). tl;dr `npm test` for the fast stuff, `npm run e2e` spins up a real Chromium with the extension and flies a full test mission.

## license

MIT. go build cool stuff.
