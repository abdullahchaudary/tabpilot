# the flight deck

every tool Claude gets, what it does, and the knobs. your agent sees short versions of these descriptions automatically. this page is for you.

**the basic loop:** `tab_open` → `snapshot` → act on refs → check `console` / `network` → repeat.

## targeting elements

anything that touches an element (`click`, `hover`, `type`, `scroll`, `select_option`, `screenshot`) takes one of:

| | example | notes |
|---|---|---|
| `ref` | `"e12"` | from the latest `snapshot`. the most reliable option. refs reset on every snapshot and navigation |
| `selector` | `"#email"`, `"button[type=submit]"` | plain CSS, first match |
| `text` | `"Sign in"` | visible text of a button, link, label, tab or menu item. exact matches win, then the shortest match |

`click` also takes raw `x`/`y` viewport coordinates, for canvases and other weird stuff.

if something's covering the element (cookie banner, modal, a sticky header), `click` still clicks, because that's what a real user would hit, and it tells Claude what got in the way.

---

## cockpit

### `status`
is a browser connected, which tab is this session driving, how many sessions are up, what's the allow-list. cheap. Claude should call it when something feels off.

## tabs

### `tabs_list`
every open tab in the browser, with ids. `▸` marks the tab this session's driving, `[visible]` marks the tab in front in its window.

### `tab_open`
| param | |
|---|---|
| `url` | where to go. bare `localhost:3000` gets `http://` added |
| `background` | open without stealing focus |

opens a tab in this session's tab group, attaches the debugger **before** loading the page (so you catch startup logs), then navigates and waits for load.

### `tab_select`
| param | |
|---|---|
| `tabId` | from `tabs_list` |
| `focus` | bring it to the front |
| `force` | grab a tab you released with Cancel. only after you say yes |

takes over a tab that's already open. console/network history starts from now, so reload to see startup stuff.

### `tab_close`
closes `tabId`, or the current tab.

## getting around

### `navigate`
| param | |
|---|---|
| `url` | go here |
| `action` | `back`, `forward`, `reload`, `hard-reload` (skips cache) |
| `timeoutMs` | how long to wait for load, default 20s |

waits for *that* navigation's `load` event, tracked by CDP's loader ID, so a slow earlier navigation can't fool it. same-page moves (hash links, SPA route changes, back/forward inside an SPA) come back right away as "Moved (same page, no reload)". if a load times out, it tells you where the page got to instead of failing.

a few things it handles so Claude doesn't get confused:

- **bare hosts**: `localhost:3000`, `myapp.test:8080` and `example.com` all get `http://` added
- **back/forward from the cache**: pages Chrome restores from its back/forward cache count as loaded right away
- **error pages**: a 4xx/5xx with an empty body loads fine, with a heads-up that Chrome is showing its own error page. a site that can't be reached, or gets blocked by an ad blocker, comes back as an error right away instead of waiting out the timeout
- **browser pages**: `chrome://`, `about:` and friends are off-limits to every extension, so they're refused up front. if *you* left the tab on one, `navigate` still drives it off to a normal page
- **`data:` URLs**: Chrome won't open those in a tab from the debugger. open a real page and build content with `evaluate`
- **the tab goes away**: if the tab gets closed or you take it back mid-load, the call fails right away and says why

## eyes

### `snapshot`
| param | default | |
|---|---|---|
| `includeText` | `true` | include the page's visible text |
| `maxText` | `6000` | chars of text |
| `maxElements` | `250` | interactive elements |

the main way Claude sees a page. looks like:

```
Flight Deck Test | http://127.0.0.1:3000/
scroll 0/412px

Interactive elements:
[e1] button "Increment"
[e2] text "Your name"
[e3] select "Aisle"
[e4] link "Docs" → /docs
[e5] checkbox "Remember me" unchecked
[e6] button "Pay now" disabled (offscreen)

Page text:
Preflight
...
```

it's way cheaper than a screenshot, so Claude should use it for most things and only screenshot when the look of something matters. doesn't go into iframes or shadow DOM. use `evaluate` or `cdp` for those.

### `screenshot`
| param | |
|---|---|
| `fullPage` | the whole scrollable page, JPEG by default. super tall pages get cropped and Claude's told where |
| `ref` / `selector` / `text` | just that element |
| `format` | `png` or `jpeg`. big PNGs switch to JPEG on their own |
| `maxWidth` | max image width in pixels, default 1568 |
| `save` | `true` saves to `~/.tabpilot/screenshots/`, or give it an absolute path |

the image goes straight back to Claude, and it *looks* at it, same as when you paste a screenshot into the chat. along with it comes a line like `viewport, 1568×980px png (scaled 61% from 2560px wide). Saved to ~/.tabpilot/screenshots/2026-...png`.

sizing is handled for you. Claude reads images best around 1568px wide and rejects anything over 8000px or 5MB, so retina captures get scaled down, tall full-page shots get cropped, and oversized PNGs fall back to JPEG.

`save` is handy for bug reports, PR descriptions, and before/after comparisons. the file lands on the machine running the daemon, the same one Claude's on.

background tabs can't paint, so if the tab's hidden, tabpilot brings it to the front first.

## hands

### `click`
| param | |
|---|---|
| target or `x`+`y` | see above |
| `button` | `left` (default), `right`, `middle` |
| `double` | double-click |
| `modifiers` | `["Control"]`, `["Meta","Shift"]`... |

these are real mouse events through CDP (move, press, release), so hover states, focus, pointer events and framework handlers all fire like they would for a person.

### `hover`
moves the mouse over the target. for menus, tooltips and hover styles.

### `type`
| param | |
|---|---|
| target | optional. clicks into it first |
| `value` | the text |
| `clear` | replace what's there. defaults to `true` when there's a target |
| `submit` | hit Enter after |

uses `Input.insertText`, which fires the real `input` events, so React/Vue/Svelte controlled inputs update properly.

### `press`
| param | |
|---|---|
| `key` | `Enter`, `Escape`, `Tab`, `Backspace`, `ArrowDown`, `PageDown`, a single character, or combos like `Control+a`, `Shift+Tab`, `Meta+k` |
| `times` | repeat, up to 50 |

### `select_option`
picks an option in a native `<select>` by value or label. for custom dropdowns (headless UI, MUI...) just `click` it open and `click` the option.

### `scroll`
| param | |
|---|---|
| target | optional. scrolls whatever's under that element (handy for scrollable panels) |
| `deltaY` / `deltaX` | pixels, default 600 down |
| `intoView` | just bring the target into view |

uses real wheel events, so scroll listeners and infinite scroll fire.

### `wait_for`
| param | |
|---|---|
| `selector` | wait until it exists and is visible |
| `text` | wait until this text is on the page |
| `gone` | wait for it to go away instead (spinners!) |
| `timeoutMs` | default 10s |

## black box

### `console`
| param | |
|---|---|
| `level` | `all`, `error`, `warn` (warnings and errors), `info`, `log`, `debug` |
| `since` | only entries after this seq number |
| `search` | only entries containing this text |
| `limit` | default 100, newest kept |
| `clear` | empty the buffer after reading |

catches `console.*` calls (with objects formatted nicely), uncaught exceptions and unhandled rejections, browser-level messages (failed resources, CSP, CORS, deprecations), navigation markers, and auto-accepted dialogs.

```
#3 12:01:02.114 LOG   page booted 42  (app.js:12)
#4 12:01:02.120 WARN  low fuel  (app.js:13)
#7 12:01:02.180 ERROR [network] Failed to load resource: the server responded with a status of 404 (Not Found)  (missing)
#9 12:01:04.002 ERROR boom Object {count: 1}  (app.js:3)
#10 12:01:05.330 DIALOG alert("fasten seatbelts") → auto-accepted

latest seq 10; pass since: 10 next time to get only new entries
```

the `since` trick is the move: do something, then read `console` with `since` to see only what that action caused.

### `network`
| param | |
|---|---|
| `filter` | URL substring |
| `type` | `XHR`, `Fetch`, `Document`, `Script`, `Stylesheet`, `Image`, `WebSocket`... |
| `failed` | only network failures and 4xx/5xx |
| `since` / `limit` / `clear` | same idea as console |

```
#4 GET 200 Fetch 31B 12ms http://localhost:3000/api/data
#5 GET 404 Fetch 4B 9ms http://localhost:3000/api/missing
#6 POST 200 Fetch 17B 15ms http://localhost:3000/api/echo
#7 GET ✗ net::ERR_CONNECTION_REFUSED Script http://localhost:9999/analytics.js
```

### `network_detail`
| param | |
|---|---|
| `seq` | the `#` from `network` |
| `maxBody` | default 20000 chars |

request headers, request body, status, response headers, and the response body if it's text. bodies live in Chrome's memory, so they're gone after the page navigates away.

## power tools

### `evaluate`
runs a JS expression in the page and returns the result as JSON. promises get awaited. good for reading app state (`window.__store.getState()`), `localStorage`, feature flags, or anything else.

### `viewport`
| param | |
|---|---|
| `width`, `height` | CSS pixels |
| `mobile` | phone mode: touch events plus meta-viewport handling |
| `deviceScaleFactor` | e.g. `3` for a retina iPhone |
| `reset` | back to normal |

heads up: in `mobile` mode, a page without `<meta name="viewport">` lays out at 980px wide, same as a real phone. that's usually the bug you're looking for.

### `cdp`
| param | |
|---|---|
| `method` | any [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) method |
| `params` | its params |

the escape hatch. some fun ones:

- `Performance.getMetrics` (after `Performance.enable`) for heap, DOM nodes, layout counts
- `Network.emulateNetworkConditions` to test on slow 3G
- `Emulation.setGeolocationOverride`, `Emulation.setTimezoneOverride`, `Emulation.setLocaleOverride`
- `Emulation.setEmulatedMedia` with `prefers-color-scheme: dark` to check your dark mode
- `Network.setCookie`, `Network.clearBrowserCookies`, `Storage.clearDataForOrigin`
- `DOM.setFileInputFiles` for uploads (the paths are on the **browser's** machine)

## automatic stuff you don't have to think about

- **dialogs**: `alert`, `confirm`, `prompt` and `beforeunload` would freeze the page. tabpilot accepts them right away and logs them to the console. only on tabs a session is actually driving: tabs it let go of are yours again. if one pops up while you've paused it, it gets answered when you resume
- **startup logs**: `tab_open` attaches before navigating, so nothing gets missed
- **one tab at a time**: when a session switches to another tab, it lets go of the old one (unless another session is still on it)
- **cleanup**: when a session ends, its debugger attachments get released. sessions that vanish without saying bye (killed client) expire after an hour of silence. tabs untouched for 15 minutes get let go too, and the next tool call picks them back up (recording pauses in between)
- **pause**: if you hit Pause in the popup, every tool fails fast with a message telling the AI to wait for you
- **finding its way back**: each session's tabs live in a tab group named after it. if the daemon restarts or the browser reconnects, the session comes back to the exact tab it was driving (remembered in `~/.tabpilot/sessions.json`), or falls back to its tab group
