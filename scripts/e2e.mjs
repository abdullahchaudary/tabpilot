// End-to-end flight test: real Chromium + the real extension + the real daemon, driven through the stdio shim
// exactly like Claude Code would. Needs a Chromium that still accepts --load-extension (Chrome for Testing,
// Playwright's chromium, or plain Chromium; branded Google Chrome 137+ dropped the flag).
//
//   CHROME=/path/to/chrome npm run e2e
//
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist/cli.js");
const extDir = join(root, "extension");
const EXT_ID = "bhfdplcnlbphflpcffgabmdmnckndojf";
const PORT = 7391;
// E2E_LAN=<ip> runs the whole flight over a non-loopback address, in LAN mode.
const LAN = process.env.E2E_LAN;
const PAGE_PORT = 7392;
const CDP_PORT = 7393;

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pw = join(homedir(), ".cache/ms-playwright");
  if (existsSync(pw)) {
    const dirs = readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const p = join(pw, d, "chrome-linux64/chrome");
      if (existsSync(p)) return p;
    }
  }
  for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser"]) if (existsSync(p)) return p;
  throw new Error("No Chromium found. Set CHROME=/path/to/chromium");
}

const home = mkdtempSync(join(tmpdir(), "tabpilot-e2e-"));
const env = { ...process.env, TABPILOT_HOME: home, TABPILOT_PORT: String(PORT) };
const cleanup = [];
let failures = 0;

function check(name, cond, detail = "") {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${!cond && detail ? `\n      ${String(detail).slice(0, 600).replace(/\n/g, "\n      ")}` : ""}`);
  if (!cond) failures++;
}

const textOf = (r) => r.content.map((c) => c.text ?? `[${c.type}]`).join("\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a little app to test against
const PAGE = `<!doctype html><html><head><title>Flight Deck Test</title></head><body>
<h1>Preflight</h1>
<button id="inc" onclick="n.textContent = +n.textContent + 1; console.error('boom', {count: +n.textContent})">Increment</button>
<span id="n">0</span>
<input id="name" placeholder="Your name" oninput="echo.textContent = this.value">
<p id="echo"></p>
<select id="seat"><option value="a">Aisle</option><option value="w">Window</option></select>
<button onclick="alert('fasten seatbelts')">Alert me</button>
<button onclick="setTimeout(() => { const d = document.createElement('div'); d.id = 'late'; d.textContent = 'Landed'; document.body.append(d); }, 500)">Delayed</button>
<script>
  console.log('page booted', 42);
  console.warn('low fuel');
  fetch('/api/data').then(r => r.json()).then(d => console.log('data', d.ok));
  fetch('/api/missing');
  fetch('/api/echo', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({hello: 'tower'})});
</script>
</body></html>`;

const pageServer = createServer((req, res) => {
  if (req.url === "/api/data") return res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"altitude":35000}');
  if (req.url === "/api/missing") return res.writeHead(404, { "content-type": "text/plain" }).end("nope");
  if (req.url === "/api/echo") {
    let b = "";
    req.on("data", (c) => (b += c));
    return req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(b));
  }
  res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
});
await new Promise((r) => pageServer.listen(PAGE_PORT, "127.0.0.1", r));
cleanup.push(() => pageServer.close());
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;

try {
  console.log(`\n✈  tabpilot e2e${LAN ? ` over LAN (${LAN})` : ""}\n`);

  // 1. config + pairing code
  execFileSync(process.execPath, [cli, "pair"], { env, stdio: "ignore" });
  if (LAN) execFileSync(process.execPath, [cli, "lan", LAN], { env, stdio: "ignore" });
  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  check("config created with a pairing code", /^tp-/.test(cfg.pairingCode));

  // 2. two MCP clients through the shim (the first one boots the daemon)
  const connectClient = async (name) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, stderr: "pipe" });
    const c = new Client({ name, version: "1" });
    await c.connect(transport);
    cleanup.push(() => c.close().catch(() => {}));
    return c;
  };
  const a = await connectClient("e2e-a");
  const b = await connectClient("e2e-b");
  const tools = await a.listTools();
  check(`shim lists tools (${tools.tools.length})`, tools.tools.length >= 20, tools.tools.map((t) => t.name).join(","));
  check("server instructions come through the shim", (a.getInstructions() ?? "").includes("snapshot"));
  const call = async (c, name, args = {}) => c.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });

  let r = await call(a, "status");
  check("status reports no browser before pairing", textOf(r).includes("No browser connected"), textOf(r));

  // 3. launch Chromium with the extension
  const profile = mkdtempSync(join(tmpdir(), "tabpilot-chrome-"));
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--disable-gpu",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${CDP_PORT}`,
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  cleanup.push(() => {
    chrome.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  });

  let version;
  for (let i = 0; i < 50 && !version; i++) {
    await sleep(200);
    version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((x) => x.json()).catch(() => null);
  }
  check(`chromium up (${version?.Browser})`, !!version);

  // 4. pair the extension through its popup, like a human would
  const popup = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?chrome-extension://${EXT_ID}/popup.html`, { method: "PUT" }).then((x) => x.json());
  check("extension loaded with the fixed ID", popup.url?.includes(EXT_ID), JSON.stringify(popup));
  const pws = new WebSocket(popup.webSocketDebuggerUrl);
  await new Promise((r) => pws.once("open", r));
  let cdpId = 0;
  const popupEval = (expression) =>
    new Promise((res) => {
      const id = ++cdpId;
      pws.on("message", function h(m) {
        const msg = JSON.parse(m);
        if (msg.id === id) {
          pws.off("message", h);
          res(msg.result?.result?.value);
        }
      });
      pws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  await sleep(500);

  // wrong code first: the daemon must refuse it
  await popupEval(`(async () => {
    document.getElementById('server').value = 'ws://${LAN ?? "127.0.0.1"}:${PORT}/ext';
    document.getElementById('code').value = 'tp-wrong-wrong-wrong-wrong';
    document.getElementById('connect').click();
  })()`);
  await sleep(1500);
  const bad = await popupEval(`chrome.storage.local.get('status').then(s => s.status)`);
  check("wrong pairing code is rejected", bad?.state === "error" && /doesn't match/.test(bad.detail), JSON.stringify(bad));

  await popupEval(`(async () => {
    document.getElementById('code').value = ${JSON.stringify(cfg.pairingCode)};
    document.getElementById('connect').click();
  })()`);
  let st;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    st = await popupEval(`chrome.storage.local.get('status').then(s => s.status)`);
    if (st?.state === "connected") break;
  }
  check("extension pairs with the right code", st?.state === "connected", JSON.stringify(st));
  const popupText = await popupEval(`document.getElementById('state').textContent`);
  check("popup shows Connected", popupText?.startsWith("Connected"), popupText);

  r = await call(a, "status");
  check("status sees the browser", textOf(r).includes("✓ Browser connected") && textOf(r).includes("sessions flying: 2"), textOf(r));

  // 5. fly
  r = await call(a, "tab_open", { url: PAGE_URL });
  check("tab_open loads the page", textOf(r).includes("Flight Deck Test"), textOf(r));

  r = await call(a, "snapshot");
  const snap = textOf(r);
  check("snapshot lists elements with refs", /\[e\d+\] button "Increment"/.test(snap) && snap.includes('textbox') === false && /\[e\d+\] text "Your name"/.test(snap), snap);
  check("snapshot includes page text", snap.includes("Preflight"));

  r = await call(a, "click", { text: "Increment" });
  r = await call(a, "click", { selector: "#inc" });
  const count = textOf(await call(a, "evaluate", { expression: "document.getElementById('n').textContent" }));
  check("click by text and selector fire real handlers", count === "2", count);

  const nameRef = snap.match(/\[(e\d+)\] text "Your name"/)?.[1];
  await call(a, "type", { ref: nameRef, value: "Maverick" });
  await call(a, "type", { ref: nameRef, value: "Goose" });
  let echo = textOf(await call(a, "evaluate", { expression: "document.getElementById('echo').textContent" }));
  check("type by ref clears and fires input events", echo === "Goose", echo);
  await call(a, "press", { key: "Control+a" });
  await call(a, "press", { key: "Backspace" });
  echo = textOf(await call(a, "evaluate", { expression: "document.getElementById('name').value" }));
  check("press handles combos (Ctrl+A, Backspace)", echo === "", JSON.stringify(echo));

  r = await call(a, "select_option", { selector: "#seat", option: "Window" });
  const seat = textOf(await call(a, "evaluate", { expression: "document.getElementById('seat').value" }));
  check("select_option picks by label", seat === "w", textOf(r));

  await call(a, "click", { text: "Alert me" });
  await sleep(300);

  await call(a, "click", { text: "Delayed" });
  r = await call(a, "wait_for", { selector: "#late" });
  check("wait_for sees late elements", textOf(r).startsWith("Found it"), textOf(r));

  r = await call(a, "console");
  const con = textOf(r);
  check("console captured log/warn/error with args", con.includes("page booted 42") && con.includes("WARN  low fuel") && /ERROR boom Object \{count: 2\}/.test(con), con);
  check("console logged the auto-accepted dialog", con.includes('alert("fasten seatbelts") → auto-accepted'), con);
  check("console captured the 404 as a browser-level error", /404/.test(con), con);
  const lastSeq = Number(con.match(/latest seq (\d+)/)?.[1]);
  r = await call(a, "console", { since: lastSeq });
  check("console since= returns only new entries", textOf(r).includes("quiet"), textOf(r));

  r = await call(a, "console", { level: "error" });
  check("console level=error filters", !textOf(r).includes("low fuel") && textOf(r).includes("boom"), textOf(r));

  r = await call(a, "network");
  const net = textOf(r);
  check("network lists requests with status", /GET 200 Fetch .*\/api\/data/.test(net) && /GET 404 Fetch .*\/api\/missing/.test(net), net);
  r = await call(a, "network", { failed: true });
  check("network failed=true finds the 404 only", textOf(r).includes("/api/missing") && !textOf(r).includes("/api/data"), textOf(r));

  const echoSeq = Number(net.match(/#(\d+) POST 200/)?.[1]);
  r = await call(a, "network_detail", { seq: echoSeq });
  const det = textOf(r);
  check("network_detail shows request body, headers and response body", det.includes('{"hello":"tower"}') && /content-type: application\/json/i.test(det), det);

  r = await call(a, "screenshot");
  check("screenshot returns a PNG", r.content[0]?.type === "image" && r.content[0].mimeType === "image/png" && r.content[0].data.length > 1000);
  r = await call(a, "screenshot", { selector: "h1" });
  check("element screenshot works", r.content[0]?.type === "image");
  r = await call(a, "screenshot", { fullPage: true });
  check("full page screenshot is a JPEG", r.content[0]?.mimeType === "image/jpeg");

  r = await call(a, "viewport", { width: 390, height: 844, mobile: true });
  const w = textOf(await call(a, "evaluate", { expression: "screen.width + 'x' + screen.height + ' touch=' + navigator.maxTouchPoints" }));
  check("viewport emulation (mobile)", w.startsWith("390x844") && !w.endsWith("touch=0"), w);
  await call(a, "viewport", { width: 800, height: 600 });
  const w2 = textOf(await call(a, "evaluate", { expression: "innerWidth" }));
  check("viewport emulation (desktop)", w2 === "800", w2);
  await call(a, "viewport", { reset: true });

  r = await call(a, "scroll", { deltaY: 300 });
  check("scroll works", textOf(r).startsWith("Scrolled"), textOf(r));

  r = await call(a, "navigate", { action: "reload" });
  check("reload waits for load", textOf(r).startsWith("Loaded"), textOf(r));
  r = await call(a, "console", { search: "navigated" });
  check("navigations are marked in the console", textOf(r).includes("navigated to"), textOf(r));

  r = await call(a, "cdp", { method: "Performance.enable" });
  r = await call(a, "cdp", { method: "Performance.getMetrics" });
  check("raw cdp passthrough", textOf(r).includes("JSHeapUsedSize"), textOf(r).slice(0, 200));

  // 6. a second session gets its own tab, and sees the first one's in tabs_list
  r = await call(b, "snapshot");
  check("session B has no tab until it picks one", r.isError && textOf(r).includes("No tab selected"), textOf(r));
  r = await call(b, "tab_open", { url: PAGE_URL + "?b" });
  r = await call(b, "tabs_list");
  const tl = textOf(r);
  check("tabs_list shows both sessions' tabs, ▸ marks mine", (tl.match(/Flight Deck Test/g) ?? []).length >= 2 && /▸ \d+ .*\?b/.test(tl), tl);
  const aTab = Number(tl.match(/^\s+(\d+)\s+Flight Deck Test\s+http:\/\/127\.0\.0\.1:\d+\/\s/m)?.[1]);
  r = await call(b, "tab_select", { tabId: aTab });
  check("session B can grab session A's tab", textOf(r).startsWith("Now driving"), textOf(r));
  await call(a, "evaluate", { expression: "window.__fromA = 'roger'" });
  r = await call(b, "evaluate", { expression: "window.__fromA" });
  check("both sessions see the same live page", textOf(r) === "roger", textOf(r));

  // 7. guard rails
  r = await call(a, "evaluate", { expression: "throw new Error('kaboom')" });
  check("page errors come back as tool errors", r.isError && textOf(r).includes("kaboom"), textOf(r));
  r = await call(a, "click", { ref: "e999" });
  check("stale refs get a helpful error", r.isError && textOf(r).includes("fresh snapshot"), textOf(r));

  // 8. daemon restarts mid-flight: shims and the extension both find their way back
  execFileSync(process.execPath, [cli, "restart"], { env, stdio: "ignore" });
  let back = "";
  for (let i = 0; i < 40 && !back.includes("✓ Browser connected"); i++) {
    await sleep(500);
    back = textOf(await call(a, "status"));
  }
  check("after a daemon restart, the shim reconnects and the extension re-pairs", back.includes("✓ Browser connected"), back);
  r = await call(a, "tab_open", { url: PAGE_URL + "?after-restart" });
  check("and it can still fly", textOf(r).includes("Flight Deck Test"), textOf(r));

  // 9. mayday
  await popupEval(`document.getElementById('mayday').click()`);
  await sleep(800);
  r = await call(a, "status");
  check("MAYDAY disconnects the browser", textOf(r).includes("No browser connected"), textOf(r));

  pws.close();
} catch (e) {
  failures++;
  console.error("\n✗ crashed:", e);
} finally {
  for (const fn of cleanup.reverse()) await fn();
  try {
    execFileSync(process.execPath, [cli, "stop"], { env, stdio: "ignore" });
  } catch {}
  if (failures) console.log(`\n  daemon log: ${join(home, "daemon.log")}`);
  else rmSync(home, { recursive: true, force: true });
  console.log(failures ? `\n✗ ${failures} check(s) failed\n` : "\n✓ all checks passed. Smooth landing.\n");
  process.exit(failures ? 1 : 0);
}
