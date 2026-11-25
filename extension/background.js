// tabpilot extension service worker.
// Dials the daemon, pairs over an encrypted channel, then does what it's told:
// tab management plus raw CDP via chrome.debugger. All the smarts live in the daemon;
// this side stays small so you rarely need to reload the extension.

import { Channel, deriveKeys, PROTOCOL_VERSION, randomNonce } from "./wire.js";

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_SERVER = "ws://127.0.0.1:7337/ext";

// CDP events the daemon cares about (console, network, page lifecycle, dialogs).
const FORWARD = new Set([
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Log.entryAdded",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Page.loadEventFired",
  "Page.domContentEventFired",
  "Page.frameNavigated",
  "Page.javascriptDialogOpening",
]);

let ws = null;
let channel = null;
let retryDelay = 1000;
let retryTimer = null;
let heartbeat = null;
const attached = new Set();

// ---------------------------------------------------------------- status

async function setStatus(state, detail = "") {
  await chrome.storage.local.set({ status: { state, detail, at: Date.now(), tabs: attached.size } });
  const badge = { connected: ["ON", "#2f9e44"], connecting: ["…", "#868e96"], error: ["!", "#e03131"], off: ["", "#868e96"] }[state];
  chrome.action.setBadgeText({ text: badge[0] });
  chrome.action.setBadgeBackgroundColor({ color: badge[1] });
}

async function settings() {
  const s = await chrome.storage.local.get(["server", "pairingCode", "enabled"]);
  return { server: s.server || DEFAULT_SERVER, pairingCode: s.pairingCode || "", enabled: !!s.enabled };
}

// ---------------------------------------------------------------- connection

async function connect(force = false) {
  const { server, pairingCode, enabled } = await settings();
  if (!enabled || !pairingCode) return setStatus("off");
  // After a hard failure (wrong code, version mismatch) wait for the user instead of hammering the daemon.
  if (!force && (await chrome.storage.local.get("status")).status?.state === "error") return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(retryTimer);
  await setStatus("connecting", server);

  let socket;
  try {
    socket = new WebSocket(server);
  } catch (e) {
    await setStatus("error", `Bad server address: ${e.message}`);
    return;
  }
  ws = socket;
  const clientNonce = randomNonce();

  socket.onopen = () => socket.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, nonce: clientNonce }));

  socket.onmessage = async (ev) => {
    if (socket !== ws) return;
    if (!channel) {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return socket.close();
      }
      if (msg.t !== "challenge") return socket.close();
      const keys = await deriveKeys(pairingCode, clientNonce, msg.nonce);
      channel = new Channel(
        keys.c2s,
        keys.s2c,
        (frame) => socket.readyState === WebSocket.OPEN && socket.send(frame),
        onMessage,
        () => socket.close(4001, "decrypt failed"),
      );
      channel.send({ t: "auth", userAgent: navigator.userAgent, version: VERSION });
      return;
    }
    channel.receive(ev.data);
  };

  socket.onclose = async (ev) => {
    if (socket !== ws) return;
    ws = null;
    channel = null;
    clearInterval(heartbeat);
    if (ev.code === 4001) return setStatus("error", "Pairing code doesn't match. Run `tabpilot pair` and paste the code again.");
    if (ev.code === 4002) return setStatus("error", `Version mismatch: ${ev.reason}. Update the extension or the daemon.`);
    if (ev.code === 4003) return setStatus("error", "Another browser connected to this daemon and took over.");
    const { enabled } = await settings();
    if (!enabled) return setStatus("off");
    await setStatus("connecting", `Daemon unreachable, retrying in ${Math.round(retryDelay / 1000)}s. Is it running? (\`tabpilot start\`)`);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  };

  socket.onerror = () => {}; // onclose handles it
}

async function disconnect() {
  clearTimeout(retryTimer);
  const s = ws;
  ws = null;
  channel = null;
  clearInterval(heartbeat);
  if (s) s.close(1000, "user disconnected");
  await setStatus("off");
}

function onMessage(msg) {
  if (msg.t === "welcome") {
    retryDelay = 1000;
    setStatus("connected", `daemon v${msg.daemonVersion ?? "?"}`);
    // Chrome keeps a service worker alive while its WebSocket is busy. A ping every 20s keeps it busy.
    clearInterval(heartbeat);
    heartbeat = setInterval(() => channel?.send({ t: "ping" }), 20_000);
    return;
  }
  if (typeof msg.id === "number") handle(msg);
}

async function handle({ id, method, params }) {
  try {
    const result = await (handlers[method] ?? unknown(method))(params ?? {});
    channel?.send({ id, result: result ?? null });
  } catch (e) {
    channel?.send({ id, error: e?.message ?? String(e) });
  }
}

const unknown = (method) => () => {
  throw new Error(`Extension doesn't know "${method}". Is it older than the daemon? Reload it from chrome://extensions.`);
};

// ---------------------------------------------------------------- commands

const tabInfo = (t) => ({ id: t.id, windowId: t.windowId, url: t.url ?? t.pendingUrl ?? "", title: t.title ?? "", active: t.active, groupId: t.groupId });

const handlers = {
  "tabs.list": async () => (await chrome.tabs.query({})).map(tabInfo),

  "tabs.get": async ({ tabId }) => tabInfo(await chrome.tabs.get(tabId)),

  "tabs.create": async ({ active = true, groupId, groupTitle, groupColor }) => {
    let tab;
    try {
      tab = await chrome.tabs.create({ url: "about:blank", active });
    } catch {
      // No normal window open. Make one.
      const w = await chrome.windows.create({ url: "about:blank", focused: active });
      tab = w.tabs[0];
    }
    let gid = null;
    try {
      if (groupId != null) {
        try {
          gid = await chrome.tabs.group({ tabIds: [tab.id], groupId });
        } catch {
          gid = null; // group is gone or in another window
        }
      }
      if (gid == null) {
        gid = await chrome.tabs.group({ tabIds: [tab.id] });
        await chrome.tabGroups.update(gid, { title: groupTitle ?? "tabpilot", color: groupColor ?? "blue" });
      }
    } catch {
      gid = null; // tab groups unsupported (some Chromium forks). Not a big deal.
    }
    return { tabId: tab.id, groupId: gid };
  },

  "tabs.close": async ({ tabId }) => chrome.tabs.remove(tabId),

  "tabs.activate": async ({ tabId }) => {
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  },

  "debugger.attach": async ({ tabId }) => {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (!/already attached/i.test(msg)) {
        if (/cannot access|chrome:\/\/|chrome-extension:\/\//i.test(msg)) throw new Error("Chrome doesn't let extensions debug this page (chrome://, the Web Store, other extensions). Pick a regular web page.");
        throw e;
      }
    }
    attached.add(tabId);
    setStatus("connected", "");
  },

  "debugger.detach": async ({ tabId }) => {
    attached.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    setStatus("connected", "");
  },

  cdp: ({ tabId, method, params }) => chrome.debugger.sendCommand({ tabId }, method, params ?? {}),
};

// ---------------------------------------------------------------- browser events -> daemon

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId != null && FORWARD.has(method)) channel?.send({ event: "cdp", tabId: source.tabId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  channel?.send({ event: "detached", tabId: source.tabId, reason });
  if (channel) setStatus("connected", "");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  channel?.send({ event: "tabRemoved", tabId });
});

// ---------------------------------------------------------------- popup + lifecycle

async function mayday() {
  // Kill switch: let go of every tab, hang up, and stay off until the user reconnects.
  for (const target of await chrome.debugger.getTargets()) {
    if (target.attached && target.tabId != null) await chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
  }
  attached.clear();
  await chrome.storage.local.set({ enabled: false });
  await disconnect();
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.cmd === "connect") {
      await chrome.storage.local.set({ enabled: true });
      retryDelay = 1000;
      if (ws) await disconnect();
      await chrome.storage.local.set({ enabled: true });
      await connect(true);
    } else if (msg.cmd === "disconnect") {
      await chrome.storage.local.set({ enabled: false });
      await disconnect();
    } else if (msg.cmd === "wake") {
      await connect();
    } else if (msg.cmd === "mayday") {
      await mayday();
    }
    reply({ ok: true });
  })();
  return true;
});

// Service workers get killed when idle. The alarm wakes us up to reconnect if that happened.
chrome.alarms.create("tabpilot-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "tabpilot-keepalive" && connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
connect();
