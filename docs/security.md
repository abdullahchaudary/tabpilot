# cabin safety

tabpilot gives an AI the controls of a browser that might be logged into your email, your GitHub, your cloud console. that's powerful, so let's be upfront about what it protects and what it doesn't.

## what's locked down

| threat | defense |
|---|---|
| a random website on the internet tries to talk to the daemon | WebSocket only accepts the tabpilot extension's origin. MCP endpoint checks the `Host` header (DNS rebinding) and needs the pairing code |
| another device on your network | daemon is localhost-only by default. in LAN mode, the extension socket still needs the pairing code and is fully encrypted. MCP is *never* served off-box |
| someone sniffing your Wi-Fi in LAN mode | every frame is AES-256-GCM encrypted with fresh keys per connection. the pairing code never goes over the wire |
| replaying or tampering with captured traffic | implicit counters plus GCM auth tags. any replayed, reordered or modified frame kills the connection |
| a different extension pretends to be tabpilot | origin check against the fixed extension ID, and it'd still need the pairing code |
| other users on a shared machine | `~/.tabpilot` is `0700` and `config.json` is `0600`. the MCP endpoint needs the code |
| the agent going somewhere it shouldn't | optional `allow` list (see below) |
| you want it to stop, now | Cancel on Chrome's debugging bar (per tab), or **MAYDAY** in the popup (everything) |

## what's not

be real with yourself about these:

- **the agent is driving your browser.** whatever it can see, it can read: cookies, `localStorage`, page content, anything in a tab it controls. if a page has prompt-injection text in it ("ignore previous instructions and..."), your agent reads that too. that's an AI risk, not a tabpilot bug, but tabpilot makes it reachable
- **the allow-list is a seatbelt, not a cage.** it blocks `tab_open`, `navigate` and `tab_select` to other hosts. it can't stop a page from redirecting, a link click from leaving the site, or `evaluate` from running `fetch()` somewhere else
- **anything running as your user can read `~/.tabpilot/config.json`.** that's the same trust level as your SSH keys and your Claude credentials
- **`cdp` and `evaluate` are full power.** that's the point. if you don't want that, don't run an agent with tabpilot in a browser you care about

## do this

1. **use a separate browser profile for agent work.** Chrome → profile icon → Add. load the extension only there. your agent profile has your test accounts, your main profile has your bank. this is the single biggest thing you can do
2. **set an allow-list** if you only ever test local stuff:
   ```json
   // ~/.tabpilot/config.json
   { "allow": ["localhost", "127.0.0.1", "*.myapp.test", "staging.myapp.com"] }
   ```
   then `tabpilot restart`. `*.example.com` matches subdomains *and* `example.com` itself
3. **don't bind LAN mode to `0.0.0.0` on a box with a public IP.** use the specific LAN or Tailscale address (see [remote.md](remote.md))
4. **rotate the code** if it leaks (pasted in a screenshot, a chat, whatever): `tabpilot rotate`, then re-pair. stdio clients pick up the new code on their own

## the visible signals

you always know when tabpilot is in control:

- the **extension badge** says `ON` (green) when paired
- **Chrome's yellow "tabpilot started debugging this browser" bar** shows up the whole time any tab is attached. Chrome forces it and extensions can't hide it, which is a good thing
- agent-opened tabs sit in a **color-coded tab group** called `tabpilot xxxx`
- the popup shows how many tabs are being flown

## the pairing code

- 120 bits of randomness, formatted like `tp-AbCdE-fGhIj-KlMnO-pQrSt`
- lives in `~/.tabpilot/config.json` on the daemon's machine, and in `chrome.storage.local` in the extension
- used for two things: deriving the per-connection encryption keys with the extension, and as the bearer token for the local MCP HTTP endpoint

## found a hole?

please open a GitHub security advisory on the repo (Security → Report a vulnerability) instead of a public issue. thanks for keeping the skies safe.
