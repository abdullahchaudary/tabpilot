const $ = (id) => document.getElementById(id);
const LABELS = { connected: "Connected", connecting: "Connecting…", error: "Problem", off: "Off" };

$("version").textContent = chrome.runtime.getManifest().version;

async function render() {
  const { server, pairingCode, status } = await chrome.storage.local.get(["server", "pairingCode", "status"]);
  if (document.activeElement !== $("server")) $("server").value = server || "ws://127.0.0.1:7337/ext";
  if (document.activeElement !== $("code")) $("code").value = pairingCode || "";
  const st = status?.state ?? "off";
  $("status").dataset.state = st;
  $("state").textContent = LABELS[st] + (st === "connected" && status.tabs ? ` · flying ${status.tabs} tab${status.tabs > 1 ? "s" : ""}` : "");
  $("detail").textContent = status?.detail || (st === "off" ? "Paste your pairing code and connect." : st === "connected" ? "Your AI has the controls." : "");
}

$("connect").onclick = async () => {
  await chrome.storage.local.set({ server: $("server").value.trim(), pairingCode: $("code").value.trim() });
  await chrome.runtime.sendMessage({ cmd: "connect" });
};
$("disconnect").onclick = () => chrome.runtime.sendMessage({ cmd: "disconnect" });
$("mayday").onclick = () => chrome.runtime.sendMessage({ cmd: "mayday" });
$("reveal").onclick = () => ($("code").type = $("code").type === "password" ? "text" : "password");

chrome.storage.onChanged.addListener(render);
render();
// Opening the popup wakes the service worker, which reconnects if Chrome put it to sleep.
chrome.runtime.sendMessage({ cmd: "wake" }).catch(() => {});
