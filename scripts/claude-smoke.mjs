// The "can Claude actually see?" test. Real Claude Code + real Chromium + the extension.
// The page draws a random code onto a <canvas>. It's not in the DOM, so snapshot can't find it;
// the only way Claude gets it right is by taking a screenshot and reading the pixels.
//
//   npm run build && node scripts/claude-smoke.mjs
//
// Needs `claude` on PATH (logged in) and a Chromium that accepts --load-extension (see CONTRIBUTING.md).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist/cli.js");
const EXT_ID = "bhfdplcnlbphflpcffgabmdmnckndojf";
const PORT = 7371, PAGE_PORT = 7372, CDP_PORT = 7373;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const words = ["ORBIT", "CONDOR", "JETSTREAM", "AILERON", "TAILWIND", "HANGAR", "RUNWAY", "ALTIMETER"];
const secret = `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(1000 + Math.random() * 9000)}`;

const PAGE = `<!doctype html><html><head><title>Mystery Panel</title></head>
<body style="margin:0;background:#0b1020;font-family:sans-serif;color:#9aa">
<p style="padding:16px">The code is on the panel below.</p>
<canvas id="c" width="900" height="260"></canvas>
<script>
  const s = ${JSON.stringify(secret.split(""))}.join("");
  const g = document.getElementById("c").getContext("2d");
  g.fillStyle = "#f5c518"; g.fillRect(40, 20, 820, 220);
  g.fillStyle = "#111"; g.font = "bold 96px sans-serif"; g.textBaseline = "middle";
  g.fillText(s, 80, 130);
</script></body></html>`;

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const pw = join(homedir(), ".cache/ms-playwright");
  for (const d of existsSync(pw) ? readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : []) {
    const p = join(pw, d, "chrome-linux64/chrome");
    if (existsSync(p)) return p;
  }
  throw new Error("No Chromium found. Set CHROME=/path/to/chromium");
}

const home = mkdtempSync(join(tmpdir(), "tabpilot-smoke-"));
const profile = mkdtempSync(join(tmpdir(), "tabpilot-smoke-chrome-"));
const env = { ...process.env, TABPILOT_HOME: home, TABPILOT_PORT: String(PORT) };
const page = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
await new Promise((r) => page.listen(PAGE_PORT, "127.0.0.1", r));
let chrome;
let ok = false;

try {
  execFileSync(process.execPath, [cli, "start"], { env, stdio: "ignore" });
  const code = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).pairingCode;

  chrome = spawn(findChrome(), [
    "--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu", `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`, `--disable-extensions-except=${join(root, "extension")}`,
    `--load-extension=${join(root, "extension")}`, "--window-size=1280,800", "about:blank",
  ], { stdio: "ignore" });

  let up = null;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(200);
    up = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json()).catch(() => null);
  }
  const popup = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?chrome-extension://${EXT_ID}/popup.html`, { method: "PUT" }).then((r) => r.json());
  const ws = new WebSocket(popup.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));
  const evalIn = (expression) => new Promise((res) => {
    const id = Math.floor(Math.random() * 1e9);
    ws.on("message", function h(m) { const x = JSON.parse(m); if (x.id === id) { ws.off("message", h); res(x.result?.result?.value); } });
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  for (let i = 0; i < 100 && (await evalIn("document.body.dataset.ready")) !== "1"; i++) await sleep(100);
  await evalIn(`document.getElementById('server').value='ws://127.0.0.1:${PORT}/ext'; document.getElementById('code').value=${JSON.stringify(code)}; document.getElementById('connect').click()`);
  for (let i = 0; i < 100; i++) {
    if ((await evalIn("chrome.storage.local.get('status').then(s => s.status?.state)")) === "connected") break;
    await sleep(200);
  }
  ws.close();
  console.log("✈  browser paired. handing Claude the controls...\n");

  const mcpConfig = join(home, "mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { tabpilot: { command: process.execPath, args: [cli, "mcp"], env: { TABPILOT_HOME: home, TABPILOT_PORT: String(PORT) } } } }));

  const prompt = `Use the tabpilot browser tools. Open http://127.0.0.1:${PAGE_PORT}/ and find the code on the yellow panel. It is drawn on a canvas, so it is not in the page text; you have to take a screenshot and read it. Reply with ONLY the code, nothing else.`;
  // Async on purpose: the test page is served from THIS process, so blocking here would starve it.
  const run = await new Promise((done) => {
    const args = ["-p", prompt, "--mcp-config", mcpConfig, "--strict-mcp-config", "--allowedTools", "mcp__tabpilot__*", "--max-turns", "15", "--output-format", process.env.SMOKE_TRACE ? "stream-json" : "json", ...(process.env.SMOKE_TRACE ? ["--verbose"] : [])];
    const child = spawn("claude", args, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 400_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
  if (process.env.SMOKE_TRACE) {
    writeFileSync(process.env.SMOKE_TRACE, run.stdout);
    run.stdout = run.stdout.trim().split("\n").at(-1);
  }
  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    throw new Error(`claude exited ${run.status}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  }
  if (result.is_error) throw new Error(`claude reported an error (${result.subtype}): ${result.result ?? ""}`);
  const answer = String(result.result ?? "").trim();
  console.log(`  (${result.num_turns} turns, $${(result.total_cost_usd ?? 0).toFixed(3)})`);

  ok = answer.toUpperCase().includes(secret);
  console.log(`  secret on the canvas:  ${secret}`);
  console.log(`  Claude said:           ${answer}`);
  console.log(ok ? "\n✓ Claude saw the screenshot and read it. Smooth landing.\n" : "\n✗ Claude didn't read the code correctly.\n");
} catch (e) {
  console.error("✗ crashed:", e.message ?? e);
} finally {
  chrome?.kill("SIGKILL");
  page.close();
  try { execFileSync(process.execPath, [cli, "stop"], { env, stdio: "ignore" }); } catch {}
  rmSync(profile, { recursive: true, force: true });
  if (ok) rmSync(home, { recursive: true, force: true });
  else console.log(`  daemon log kept at ${join(home, "daemon.log")}`);
  process.exit(ok ? 0 : 1);
}
