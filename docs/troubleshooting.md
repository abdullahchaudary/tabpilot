# mayday mayday

something's off. start here.

## first, the instruments

```bash
tabpilot status            # is the daemon up? is a browser paired? how many sessions?
cat ~/.tabpilot/daemon.log # what the daemon's been up to
```

and click the extension icon. the status light and message usually tell you exactly what's wrong.

---

## the extension light is yellow and says "Daemon unreachable"

the extension can't reach the daemon.

- **is the daemon running?** `tabpilot status`. if not, `tabpilot start` (or just use any tabpilot tool from Claude, it starts itself)
- **remote setup?** is your SSH tunnel still up? `ssh -N -L 7337:127.0.0.1:7337 you@devbox`. tunnels die quietly when your laptop sleeps
- **right address?** local and SSH tunnel: `ws://127.0.0.1:7337/ext`. LAN: `ws://<dev box IP>:7337/ext` *and* LAN mode on (`tabpilot lan <ip>`)
- **firewall?** in LAN mode, port 7337 has to be open on the dev box
- **changed the port?** the address needs the same port as `"port"` in `~/.tabpilot/config.json`

it retries on its own (up to every 30s), so once the daemon's reachable it'll connect.

## the light is red: "Pairing code doesn't match"

the code in the extension isn't the daemon's code. run `tabpilot pair` on the machine where *Claude* runs, copy the code, paste it in, hit Connect. watch for a stray space or a missing chunk.

if you ran `tabpilot rotate`, the old code's dead. re-paste.

## red: "Version mismatch"

the extension and daemon speak different protocol versions. update both: `git pull && npm install && tabpilot restart`, then reload the extension in `chrome://extensions`.

## red: "Another browser connected to this daemon and took over"

one daemon flies one browser at a time. a second browser (or a second profile) paired and kicked this one off. hit Connect here to take it back.

## Claude doesn't have the tabpilot tools

- did you run `tabpilot install`? check with `claude mcp list` (or `claude mcp get tabpilot`)
- **start a new session.** MCP servers load when a session starts
- using a different profile? `tabpilot install --dry-run` shows which profiles it found. add a missing one with `--claude-dir /path`
- **switched Node versions** (nvm, fnm...)? the install points at an absolute node path. run `tabpilot install` again
- **moved the repo folder?** same fix, run `tabpilot install` again

## "No browser connected" from a tool

the daemon's fine, but no extension is paired right now. open the popup and hit Connect. if it was connected before, Chrome might've put the service worker to sleep and the alarm will reconnect it within ~30s. or just click the icon, which wakes it up.

## the AI says "The user paused tabpilot"

that's you! someone hit **Pause** in the popup (or `Alt+Shift+P`). the badge shows `II` in orange. open the popup and hit **Resume AI**.

## the debugging bar went away on its own / logs stopped

tabpilot lets go of tabs nobody's touched in 15 minutes, so a forgotten session can't leave the yellow bar up forever. the next tool call grabs the tab again, but anything logged while it was let go isn't recorded. reload the page if you need those startup logs.

## "Another extension is already debugging this tab"

some other extension (screenshot tools, other automation stuff) is attached with `chrome.debugger`. turn it off for that tab or use a different tab.

## "Chrome doesn't let extensions debug this page"

`chrome://` pages, the Chrome Web Store, and other extensions' pages are off-limits to every extension. that's Chrome's rule. use a regular web page.

## "The user took back tab N"

you hit Cancel on Chrome's debugging bar, or **release** in the popup. that's the "hands off" signal, so tabpilot won't reattach on its own. tell Claude it's okay and it'll call `tab_select` with `force: true`.

## screenshots hang or come back blank

background tabs don't paint. tabpilot brings hidden tabs to the front before a screenshot, but if the whole **window is minimized**, Chrome won't paint it either. un-minimize it. (on headless Linux boxes, use `--headless=new` or a virtual display.)

## clicks don't do anything

- did the page change since the last snapshot? refs reset on every snapshot and navigation. Claude should take a fresh `snapshot`
- did the click result say "something else is on top of it"? a modal or cookie banner is eating clicks. close it first
- an element inside an **iframe**? snapshot and click don't go inside iframes yet. use `cdp`, or open the iframe's URL directly

## the console is missing early logs

the console only records once tabpilot attaches. `tab_open` attaches before loading, so you get everything. with `tab_select` on an already-open tab, run `navigate` with `action: "reload"` to catch startup logs.

## `network_detail` says the body isn't available

Chrome drops response bodies when the page navigates away or the buffer fills up. call `network_detail` before you move on.

## port 7337 is taken

```bash
# pick another port
nano ~/.tabpilot/config.json     # "port": 7444
tabpilot restart
```

then update the address in the extension (and your SSH tunnel).

## total reset

```bash
tabpilot stop
rm -rf ~/.tabpilot              # new pairing code next run
tabpilot install                # re-wire clients
```

then remove and reload the extension, and pair again.

## still stuck?

open an issue with your OS, browser and version, `tabpilot --version`, and the relevant bit of `~/.tabpilot/daemon.log`. **don't paste your pairing code.**
