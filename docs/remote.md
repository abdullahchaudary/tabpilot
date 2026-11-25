# flying long-haul

the usual setup: Claude Code runs on a dev box (a VPS, a beefy desktop, a cloud VM), and your browser is on the laptop in front of you. here's how to get them talking without any servers in the middle.

the rule to remember: **the daemon lives next to Claude, and the extension dials into it.** your laptop only needs the extension. no Node, no tabpilot install.

```
   laptop                                   dev box
 ┌──────────────────────┐                ┌───────────────────────────┐
 │ browser + extension  │ ── some path ─►│ daemon :7337 ◄── Claude   │
 └──────────────────────┘                └───────────────────────────┘
```

pick a path:

| | setup | encryption | when to use |
|---|---|---|---|
| **SSH tunnel** | one command | SSH + tabpilot's own | you already SSH into the box. 90% of people |
| **LAN mode** | `tabpilot lan <ip>` | tabpilot's own | same network, no SSH handy |
| **Tailscale / WireGuard** | LAN mode on the tailnet IP | WireGuard + tabpilot's own | across networks, no port forwarding |

## option 1: SSH tunnel (do this one)

on your **laptop**:

```bash
ssh -N -L 7337:127.0.0.1:7337 you@devbox
```

in the extension popup, leave the address as `ws://127.0.0.1:7337/ext`, paste the code from `tabpilot pair` (run that on the dev box), and hit connect. done.

the daemon stays on localhost-only mode, nothing gets exposed, and you're already used to SSH. if you SSH in all day anyway, bake it into `~/.ssh/config`:

```
Host devbox
  HostName devbox.example.com
  User you
  LocalForward 7337 127.0.0.1:7337
```

now every `ssh devbox` brings the tunnel with it.

> **the daemon has to be running before the extension can connect.** it starts on its own the first time Claude uses a tabpilot tool, or you can run `tabpilot start` on the dev box. the extension keeps retrying in the background, so the order doesn't really matter.

**VS Code Remote / Cursor remote?** they forward ports too. forward 7337 from the remote and you're set.

## option 2: LAN mode

browser and dev box on the same network (home lab, office, a desktop in the next room)? on the **dev box**:

```bash
tabpilot lan 192.168.1.50     # the dev box's LAN IP. persists across restarts
tabpilot pair                 # shows the code + ws:// addresses to use
```

then in the extension put `ws://192.168.1.50:7337/ext` and the code.

what changes in LAN mode:

- the daemon adds a second listener on that address, **only for the extension socket.** the MCP endpoint still refuses anything that isn't localhost
- the traffic is plain `ws://` but every frame is AES-256-GCM encrypted with keys from your pairing code. someone sniffing the network sees noise, and someone without the code can't even get past the handshake
- only the tabpilot extension's origin is accepted. random web pages on your network get a 403

**about `0.0.0.0`:** `tabpilot lan 0.0.0.0` listens on every interface. that's fine on a laptop behind a home router, but **if your box has a public IP, that includes the internet.** the protocol holds up (the attacker still needs the code), but don't hand strangers a door to knock on. bind a specific LAN or Tailscale IP, or firewall the port.

turn it off with `tabpilot lan off`.

> newer Chrome versions are rolling out "local network access" prompts for connections to private IPs. if Chrome asks whether tabpilot can connect to devices on your local network, say yes.

## option 3: Tailscale (or any WireGuard mesh)

this is just LAN mode on your tailnet:

```bash
tabpilot lan 100.101.102.103    # the dev box's Tailscale IP (`tailscale ip -4`)
```

extension → `ws://100.101.102.103:7337/ext`. works from a coffee shop, an airport, wherever, with no ports opened. Tailscale's coordination server sets up the connection, but your traffic goes straight between your machines, and it's double-encrypted (WireGuard + tabpilot).

## multiple machines, multiple browsers

- **one daemon, one browser at a time.** if a second browser pairs with the same daemon, it takes over and the first one gets a "another browser took over" message. that's on purpose, so two browsers never end up in a weird half-state
- **one browser, several dev boxes:** the extension connects to one daemon at a time. switch by changing the address in the popup. or run each box's daemon on a different port (`"port"` in `~/.tabpilot/config.json`) and keep a tunnel per port
- **several Claude sessions on one box:** totally fine. they all share the one daemon and the one browser. that's what the daemon's for

## what about the MCP side remotely?

you shouldn't need it. Claude and the daemon live on the same box, so MCP always stays local. if you really want an MCP client on another machine to reach the daemon, tunnel `/mcp` over SSH the same way (`ssh -L 7337:127.0.0.1:7337`) and point the client at `http://127.0.0.1:7337/mcp` with the bearer header from `tabpilot config`. the daemon will never serve MCP to a non-localhost address directly, and that's not changing.
