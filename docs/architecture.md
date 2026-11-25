# how the plane is built

alright, here's the whole thing, piece by piece.

```
 ┌─────────────────┐   stdio    ┌─────────────┐
 │ Claude Code #1  │──────────► │ tabpilot    │──┐
 └─────────────────┘            │ mcp (shim)  │  │
 ┌─────────────────┐   stdio    ├─────────────┤  │   HTTP (MCP)      ┌──────────────────┐
 │ Claude Code #2  │──────────► │ tabpilot    │──┼──────────────────►│                  │
 └─────────────────┘            │ mcp (shim)  │  │  127.0.0.1:7337   │  tabpilot daemon │
 ┌─────────────────┐            └─────────────┘  │       /mcp        │  (one per box)   │
 │ any HTTP client │─────────────────────────────┘                   │                  │
 └─────────────────┘                                                 └────────▲─────────┘
                                                                              │ WebSocket /ext
                                                                              │ AES-256-GCM
                                                                              │ (extension dials out)
                                                          ┌───────────────────┴──────────────┐
                                                          │ tabpilot extension (MV3)         │
                                                          │  service worker                  │
                                                          │   ├─ chrome.tabs / tabGroups     │
                                                          │   └─ chrome.debugger ─► CDP 1.3  │
                                                          └──────────────────────────────────┘
```

## the three parts

### 1. the shim: `tabpilot mcp`

this is what your MCP client actually launches. it's tiny on purpose:

1. checks if the daemon's up (`GET /health`). if not, starts it in the background
2. opens an MCP session with the daemon over HTTP
3. speaks MCP over stdio to your client and forwards every `tools/list` and `tools/call` to the daemon

why bother? every Claude Code session spawns its own MCP process. if each one tried to own the browser connection, the second session would crash into the first over port 7337, and two sessions would fight over the same extension. so the shims are disposable and the daemon is the one that actually flies the plane.

if the daemon restarts under a shim (say you ran `tabpilot restart`), the shim reconnects on the next call and the session finds its tab again (see sessions and tabs below). no need to restart Claude. it only retries when it knows the request never ran (session gone, connection refused, code rotated), so a tool never runs twice.

### 2. the daemon: `tabpilot daemon`

one per machine. it's got:

- **`/mcp`**: streamable HTTP MCP endpoint. one MCP session per client, each with its own state (current tab, tab group). localhost only, needs `Authorization: Bearer <pairing code>`, and checks the `Host` header so a sketchy website can't DNS-rebind its way in.
- **`/ext`**: the WebSocket the extension connects to. only accepts the tabpilot extension's origin (`chrome-extension://bhfdplcnlbphflpcffgabmdmnckndojf`), then runs the pairing handshake.
- **`/health`**: name, version, whether a browser's connected. no secrets.
- **the Pilot**: turns "click e12" into CDP calls: finding the element, scrolling it into view, real `Input.dispatchMouseEvent` presses. it also tracks which session has which tab attached, shares one attach between sessions grabbing the same tab, and tracks navigations by loader ID.
- **the black box**: a recorder per tab that keeps the last 1000 console entries and 1000 network requests from CDP events.

all the smart stuff lives here, in TypeScript. that's on purpose: the extension stays dumb, so most updates are just `git pull && tabpilot restart` with no extension reload.

### 3. the extension

a Manifest V3 service worker that:

- dials the daemon (browsers can't *listen* for connections, so the extension always calls out)
- does the pairing handshake and encrypts everything
- runs a short list of commands: `tabs.list/get/create/close/activate`, `debugger.attach/detach`, and `cdp`, which is a raw `chrome.debugger.sendCommand`
- forwards the CDP events the daemon cares about: console, exceptions, log entries, network lifecycle, page loads, dialogs
- shows status, live activity and the tabs it holds in the popup, and gives you pause/resume, per-tab release, disconnect and MAYDAY (plus keyboard shortcuts)

**keeping the service worker alive.** MV3 kills idle service workers. Chrome 116+ keeps one alive while its WebSocket is busy, so the extension pings every 20s. a 30-second `chrome.alarms` alarm wakes it back up to reconnect if Chrome killed it anyway. reconnects back off from 1s to 30s.

## the wire protocol

the full spec is in the header of [`extension/wire.js`](../extension/wire.js). short version:

```
ext    → daemon   {"t":"hello","v":1,"nonce":"<16 random bytes>"}       plaintext
daemon → ext      {"t":"challenge","nonce":"<16 random bytes>"}         plaintext

both sides:  c2s, s2c = HKDF-SHA256(ikm = pairing code,
                                    salt = clientNonce ‖ serverNonce,
                                    info = "tabpilot/1 ext->daemon" | "tabpilot/1 daemon->ext")

ext    → daemon   enc{"t":"auth","userAgent":...,"version":...}
daemon → ext      enc{"t":"welcome","daemonVersion":...}

after that, every frame = base64(AES-256-GCM(json)), IV = 0x00000000 ‖ uint64 counter
```

what that gets you:

- **the pairing code never goes over the wire.** if you can decrypt `auth`, you know the code
- **fresh keys every connection.** both sides add their own random nonce
- **a key per direction**, so a frame can't be reflected back at whoever sent it
- **implicit counters**: a replayed, dropped or reordered frame just fails to decrypt, and the connection closes
- **one code path.** localhost and LAN use the exact same encrypted protocol. no "secure mode" toggle to forget about

requests look like `{id, method, params}` → `{id, result}` or `{id, error}`. events look like `{event: "cdp" | "detached" | "tabRemoved", ...}`.

`src/wire.ts` (Node) and `extension/wire.js` (browser) are two copies of the same protocol. `test/wire.test.mjs` checks they actually agree.

## sessions and tabs

- the shim makes a random key when it starts and sends it with every request. the daemon names the session's tab group after it (`tabpilot a3f9`), and the color comes from it too
- **the tab group is the session's memory.** if the daemon restarts or the browser reconnects, the session asks the extension for its group and picks up its tab again. no state file needed
- if a *different* browser pairs (or the same one restarted), every tab id is suspect. the extension sends a per-run instance id, and when it changes, sessions forget their tabs and look them up fresh
- each MCP session gets a short label and a color. `tab_open` puts its tabs in a Chrome tab group like `tabpilot a3f9`, so you can see who's driving what
- sessions can grab *any* tab with `tab_select`, including another session's or one you opened yourself. it's your browser, after all
- the debugger attachment is ref-counted. when the last session using a tab ends, tabpilot detaches and Chrome's debugging bar goes away
- if you hit **Cancel** on Chrome's debugging bar or **release** in the popup, that tab's marked as released, *in the extension* (session storage, so it survives the service worker sleeping). the extension refuses to reattach unless the agent passes `force: true`, and the tool tells it to ask you first
- **pause** is enforced in the extension too: while paused, every command gets bounced with a "the user paused tabpilot" error. the daemon mirrors the state so tools fail fast with the same message
- when the connection drops, the extension detaches from every tab, so Chrome's debugging bar never outlives the daemon
- tabs untouched for 15 minutes get detached (sessions that vanish without saying bye, like a killed client, can't leave the bar up forever). the next tool call reattaches

## why an extension and not `--remote-debugging-port`?

you could launch Chrome with a debugging port and skip the extension. but:

- you'd have to relaunch your browser with special flags, and newer Chrome won't even let you do that on your default profile
- any local process could connect to that port, with no pairing and no encryption
- you'd lose the status light, the tab groups, the kill switch, and Chrome's "being debugged" bar

`chrome.debugger` gives the extension the same CDP that port would, inside a browser you're already using.

## why not WebRTC / a cloud relay for remote?

WebRTC needs a signaling server and usually STUN/TURN, and a relay is literally an external server. the whole point is that tabpilot doesn't depend on anything we run. SSH tunnels, your LAN and Tailscale cover the real-world cases. see [remote.md](remote.md).

## files

```
src/
  cli.ts        command line
  shim.ts       stdio MCP → daemon proxy, daemon auto-start
  daemon.ts     HTTP + WebSocket server, MCP sessions, auth
  bridge.ts     the extension connection + per-tab console/network recorder
  pilot.ts      sessions, attachments, in-page scripts, mouse/keyboard
  tools.ts      the MCP tool definitions
  wire.ts       wire protocol (Node side)
  config.ts     ~/.tabpilot/config.json
  install.ts    MCP client auto-config
extension/
  manifest.json background.js wire.js popup.*
test/           wire protocol interop tests
scripts/e2e.mjs full flight test with real Chromium
```
