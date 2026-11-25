const $ = (id) => document.getElementById(id);
const send = (cmd, extra = {}) => chrome.runtime.sendMessage({ cmd, ...extra }).catch(() => {});
const LABELS = { connected: "Connected", connecting: "Connecting…", error: "Problem", off: "Off" };

$("version").textContent = chrome.runtime.getManifest().version;

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 2 ? "just now" : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : "a while ago";
}

let flight = null;
let filled = false;

async function render() {
  const { server, pairingCode, status, paused } = await chrome.storage.local.get(["server", "pairingCode", "status", "paused"]);
  ({ flight } = await chrome.storage.local.get("flight"));
  // Fill the fields once. Re-filling on every status change would wipe whatever you're halfway through typing.
  if (!filled) {
    $("server").value = server || "ws://127.0.0.1:7337/ext";
    $("code").value = pairingCode || "";
    filled = true;
  }

  const st = status?.state ?? "off";
  const live = st === "connected";
  $("status").dataset.state = live && paused ? "paused" : st;
  $("state").textContent = live && paused ? "Paused" : LABELS[st];
  $("detail").textContent = live && paused
    ? "The AI can't touch the browser until you resume."
    : status?.detail || (st === "off" ? "Paste your pairing code and connect." : live ? "Your AI has the controls." : "");

  $("deck").hidden = !live;
  $("setup").open = !live;
  $("pause").textContent = paused ? "▶ Resume AI" : "⏸ Pause AI";
  $("pause").classList.toggle("resume", !!paused);

  const tabs = flight?.tabs ?? [];
  $("tabcount").textContent = tabs.length;
  const ul = $("tabs");
  ul.replaceChildren();
  if (!tabs.length) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="t empty">none yet</span>`;
    ul.append(li);
  }
  for (const t of tabs) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "t";
    name.textContent = t.title;
    name.title = `${t.url}\nclick to jump to this tab`;
    name.onclick = () => send("focus", { tabId: t.id });
    const btn = document.createElement("button");
    btn.textContent = "release";
    btn.title = "Take this tab back. The AI has to ask before grabbing it again.";
    btn.onclick = () => send("release", { tabId: t.id });
    li.append(name, btn);
    ul.append(li);
  }
  renderActivity(paused);
}

function renderActivity(paused) {
  const a = flight?.activity;
  const el = $("activity");
  if (paused) el.innerHTML = "<b>paused</b> · waiting for you";
  else if (!a) el.textContent = "standing by";
  else {
    const tab = flight.tabs?.find((t) => t.id === a.tabId);
    el.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = a.label;
    el.append("last: ", b, ` ${tab ? "· " + tab.title + " " : ""}· ${ago(a.at)}`);
  }
}

$("connect").onclick = async () => {
  await chrome.storage.local.set({ server: $("server").value.trim(), pairingCode: $("code").value.trim() });
  await send("connect");
};
$("disconnect").onclick = () => send("disconnect");
$("mayday").onclick = () => send("mayday");
$("pause").onclick = async () => send((await chrome.storage.local.get("paused")).paused ? "resume" : "pause");
$("reveal").onclick = () => ($("code").type = $("code").type === "password" ? "text" : "password");

chrome.storage.onChanged.addListener(render);
render().then(() => (document.body.dataset.ready = "1")); // tests wait for this
setInterval(async () => renderActivity((await chrome.storage.local.get("paused")).paused), 1000);
// Opening the popup wakes the service worker, which reconnects if Chrome put it to sleep.
send("wake");
