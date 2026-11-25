# joining the crew

stoked you wanna help. here's how to get going.

## setup

```bash
git clone https://github.com/abdullahchaudary/tabpilot.git
cd tabpilot
npm install
```

load `extension/` unpacked in Chrome (see the README).

## the dev loop

```bash
npm run dev          # tsc --watch
tabpilot restart     # pick up daemon changes
```

- **changed `src/`?** rebuild and `tabpilot restart`. Claude sessions reconnect on their own, no reload needed
- **changed `extension/`?** hit reload on the extension in `chrome://extensions`, then reconnect from the popup

## tests

```bash
npm test             # wire protocol interop (fast)
npm run e2e          # the full flight: real Chromium + extension + daemon + shim
E2E_LAN=192.168.1.50 npm run e2e   # same thing, over a LAN address
```

and the big one:

```bash
node scripts/claude-smoke.mjs      # real Claude Code reads a code that only exists as pixels in a screenshot
```

it needs `claude` on your PATH and logged in, and it spends a few cents of tokens.

`e2e` and `claude-smoke` need a Chromium that still accepts `--load-extension`. Playwright's Chromium (`npx playwright install chromium`) or Chrome for Testing both work, and so does plain Chromium. branded Google Chrome dropped that flag in v137. point at a specific binary with `CHROME=/path/to/chrome`.

if you add a tool, add a check for it to `scripts/e2e.mjs`.

## where stuff goes

the architecture tour is in [docs/architecture.md](docs/architecture.md). rules of thumb:

- **logic goes in the daemon, not the extension.** the extension stays a thin CDP pipe, so most changes don't need an extension reload
- **`src/wire.ts` and `extension/wire.js` must stay in sync.** change one, change the other, run `npm test`
- **bump `PROTOCOL_VERSION`** if you change the handshake or message framing
- **new tools** go in `src/tools.ts`. write the description for the *agent*: what it does, when to reach for it, what comes back. errors should tell the agent what to do next ("take a fresh snapshot", "ask the user to pair"), not just what went wrong

## style

- TypeScript, strict. no new runtime deps unless they really earn it (right now: the MCP SDK, `ws`, `zod`)
- keep messages human. tool output is read by an AI but debugged by a person

## PRs

small and focused beats big and sprawling. say what you changed and how you tested it. if it touches security (auth, crypto, origins), call that out up top.
