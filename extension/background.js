// tabpilot extension service worker.
// Dials the daemon, pairs over an encrypted channel, then does what it's told:
// tab management plus raw CDP via chrome.debugger. All the smarts live in the daemon;
// this side stays small so you rarely need to reload the extension.
//
// The user is always in charge from here: pause/resume, release a single tab,
// disconnect, or MAYDAY (release everything + hang up). Pause is enforced HERE,
// not in the daemon, so a paused browser stays paused no matter what the other end does.

import { Channel, deriveKeys, PROTOCOL_VERSION, randomNonce } from "./wire.js";

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_SERVER = "ws://127.0.0.1:7337/ext";
const PAUSED_MSG =
  "⏸ The user paused tabpilot from the browser. Stop here and wait for them to resume it (or ask them what's up). Don't retry in a loop.";

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
  "Page.navigatedWithinDocument",
  "Page.lifecycleEvent", // filtered to "load" below; the rest is noise
]);

let ws = null;
let channel = null;
let connectQueue = Promise.resolve();
let retryDelay = 1000;
let retryTimer = null;
let heartbeat = null;
let paused = false;
// Tabs WE attached to, and tabs the user took back. Kept in session storage so they survive the service worker
// being put to sleep (Chrome keeps the debugger attached even when our worker restarts), but not a browser restart.
const attached = new Set();
const released = new Set();
let instanceId = null;
const ready = chrome.storage.session.get(["attached", "released", "instanceId"]).then(async (s) => {
  (s.attached ?? []).forEach((id) => attached.add(id));
  (s.released ?? []).forEach((id) => released.add(id));
  instanceId = s.instanceId ?? crypto.randomUUID();
  await chrome.storage.session.set({ instanceId });
});
function persistTabs() {
  chrome.storage.session.set({ attached: [...attached], released: [...released] });
  scheduleFlightUpdate();
}

// ---------------------------------------------------------------- status + flight info for the popup

let lastState = "off";

async function setStatus(state, detail = "") {
  lastState = state;
  await chrome.storage.local.set({ status: { state, detail, at: Date.now() } });
  paintBadge();
}

function paintBadge() {
  const [text, color] =
    lastState === "connected" && paused
      ? ["II", "#f08c00"]
      : { connected: ["ON", "#2f9e44"], connecting: ["…", "#868e96"], error: ["!", "#e03131"], off: ["", "#868e96"] }[lastState];
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// What the agent is doing right now, in words. Written at most every 300ms so we don't thrash storage.
let activity = null;
let flightTimer = null;
function describe(method, params) {
  if (method === "cdp") {
    const m = params.method;
    if (m === "Input.dispatchMouseEvent") return params.params?.type === "mouseWheel" ? "scrolling" : params.params?.type === "mouseMoved" ? "moving the mouse" : "clicking";
    return (
      {
        "Page.navigate": "navigating",
        "Page.reload": "reloading",
        "Page.navigateToHistoryEntry": "going back/forward",
        "Page.captureScreenshot": "taking a screenshot",
        "Input.insertText": "typing",
        "Input.dispatchKeyEvent": "pressing keys",
        "Runtime.evaluate": "reading the page",
        "Network.getResponseBody": "inspecting network traffic",
        "Network.getRequestPostData": "inspecting network traffic",
        "Emulation.setDeviceMetricsOverride": "resizing the viewport",
      }[m] ?? m
    );
  }
  return { "tabs.create": "opening a tab", "tabs.close": "closing a tab", "tabs.activate": "switching tabs", "debugger.attach": "taking the controls" }[method];
}

function scheduleFlightUpdate() {
  if (flightTimer) return;
  flightTimer = setTimeout(async () => {
    flightTimer = null;
    const tabs = [];
    for (const id of attached) {
      const t = await chrome.tabs.get(id).catch(() => null);
      if (t) tabs.push({ id, title: t.title || t.url || "(loading)", url: t.url ?? "" });
    }
    await chrome.storage.local.set({ flight: { tabs, activity, paused } });
  }, 300);
}

async function settings() {
  const s = await chrome.storage.local.get(["server", "pairingCode", "enabled"]);
  return { server: s.server || DEFAULT_SERVER, pairingCode: s.pairingCode || "", enabled: !!s.enabled };
}

// ---------------------------------------------------------------- connection

// Several things can ask to connect at once (alarm, popup, startup). They take turns, and each one
// re-checks the socket, so we never open two. A forced connect (the Connect button) is never swallowed.
function connect(force = false) {
  connectQueue = connectQueue.then(() => openSocket(force)).catch(() => {});
  return connectQueue;
}

async function openSocket(force) {
  await ready;
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
        () => socket.close(4004, "decrypt failed"),
      );
      channel.send({ t: "auth", userAgent: navigator.userAgent, version: VERSION, instanceId });
      return;
    }
    channel.receive(ev.data);
  };

  socket.onclose = async (ev) => {
    if (socket !== ws) return;
    ws = null;
    channel = null;
    clearInterval(heartbeat);
    await releaseAll(); // nobody's flying anymore, so take down Chrome's debugging bar
    if (ev.code === 4001) return setStatus("error", "Pairing code doesn't match. Run `tabpilot pair` and paste the code again.");
    if (ev.code === 4002) return setStatus("error", `Version mismatch: ${ev.reason}. Update the extension or the daemon.`);
    if (ev.code === 4003) return setStatus("error", "Another browser connected to this daemon and took over. Hit Connect to take it back.");
    const { enabled } = await settings();
    if (!enabled) return setStatus("off");
    await setStatus("connecting", `Daemon unreachable, retrying in ${Math.round(retryDelay / 1000)}s. Is it running? (\`tabpilot start\`)`);
    retryTimer = setTimeout(() => connect(), retryDelay);
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
  await releaseAll();
  await setStatus("off");
}

async function releaseAll() {
  for (const tabId of attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  attached.clear();
  persistTabs();
}

function onMessage(msg) {
  if (msg.t === "welcome") {
    retryDelay = 1000;
    setStatus("connected", `daemon v${msg.daemonVersion ?? "?"}`);
    channel.send({ event: "paused", paused }); // the daemon forgets this across reconnects; remind it
    // Chrome keeps a service worker alive while its WebSocket is busy. A ping every 20s keeps it busy.
    clearInterval(heartbeat);
    heartbeat = setInterval(() => channel?.send({ t: "ping" }), 20_000);
    return;
  }
  if (typeof msg.id === "number") handle(msg);
}

async function handle({ id, method, params }) {
  // Reply on the connection the request came in on. If the daemon restarted meanwhile, the answer is stale: drop it.
  const ch = channel;
  // Paused means hands off. Letting go of a tab is the one thing that's always allowed.
  if (paused && method !== "debugger.detach") return ch?.send({ id, error: PAUSED_MSG });
  try {
    const label = describe(method, params ?? {});
    if (label) {
      activity = { label, tabId: params?.tabId ?? null, at: Date.now() };
      scheduleFlightUpdate();
    }
    const result = await (handlers[method] ?? unknown(method))(params ?? {});
    if (ch === channel) ch?.send({ id, result: result ?? null });
  } catch (e) {
    if (ch === channel) ch?.send({ id, error: e?.message ?? String(e) });
  }
}

const unknown = (method) => () => {
  throw new Error(`Extension doesn't know "${method}". Is it older than the daemon? Reload it from chrome://extensions.`);
};

// ---------------------------------------------------------------- commands from the daemon

const tabInfo = (t) => ({ id: t.id, windowId: t.windowId, url: t.url ?? t.pendingUrl ?? "", title: t.title ?? "", active: t.active, groupId: t.groupId, status: t.status });

// Attach and detach for the same tab must not overlap, or a detach still in flight makes the next attach fail.
const tabLocks = new Map();
function withTabLock(tabId, fn) {
  const run = (tabLocks.get(tabId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  tabLocks.set(tabId, tail);
  tail.then(() => tabLocks.get(tabId) === tail && tabLocks.delete(tabId));
  return run;
}

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

  // Plain navigation without the debugger, for leaving pages Chrome won't let us debug (chrome://...).
  "tabs.navigate": async ({ tabId, url }) => {
    if (released.has(tabId)) throw new Error(`The user took back tab ${tabId}. Ask them before grabbing it again, then call tab_select with force: true.`);
    return tabInfo(await chrome.tabs.update(tabId, { url }));
  },

  "tabs.activate": async ({ tabId }) => {
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  },

  "debugger.attach": ({ tabId, force = false }) => withTabLock(tabId, async () => {
    // The user's "hands off" is enforced here, in their browser, not just in the daemon.
    if (released.has(tabId) && !force) {
      throw new Error(`The user took back tab ${tabId}. Ask them before grabbing it again, then call tab_select with force: true.`);
    }
    released.delete(tabId);
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (/already attached/i.test(msg)) {
        if (!attached.has(tabId)) throw new Error("Another extension is already debugging this tab. Turn it off for this tab, or pick another tab.");
      } else if (/cannot access|chrome:\/\/|chrome-extension:\/\//i.test(msg)) {
        throw new Error("Chrome doesn't let extensions debug this page (chrome://, the Web Store, other extensions). Pick a regular web page.");
      } else throw e;
    }
    attached.add(tabId);
    persistTabs();
  }),

  "debugger.detach": ({ tabId }) => withTabLock(tabId, async () => {
    attached.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    persistTabs();
  }),

  // Find a session's tab group by title and return its most recently used tab.
  "groups.find": async ({ title }) => {
    const [group] = await chrome.tabGroups.query({ title });
    if (!group) return null;
    const tabs = await chrome.tabs.query({ groupId: group.id });
    tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    return tabs.length ? { groupId: group.id, tabId: tabs[0].id } : null;
  },

  cdp: ({ tabId, method, params }) => {
    if (released.has(tabId)) throw new Error(`The user took back tab ${tabId}. Ask them before grabbing it again, then call tab_select with force: true.`);
    if (!attached.has(tabId)) throw new Error("tabpilot: not attached");
    return chrome.debugger.sendCommand({ tabId }, method, params ?? {});
  },
};

// ---------------------------------------------------------------- browser events -> daemon

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null || !FORWARD.has(method)) return;
  if (method === "Page.lifecycleEvent" && params.name !== "load") return;
  channel?.send({ event: "cdp", tabId: source.tabId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  if (reason === "canceled_by_user") released.add(source.tabId);
  persistTabs();
  channel?.send({ event: "detached", tabId: source.tabId, reason });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  released.delete(tabId);
  persistTabs();
  channel?.send({ event: "tabRemoved", tabId });
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (attached.has(tabId) && (change.title || change.url)) scheduleFlightUpdate();
});

// ---------------------------------------------------------------- the user's controls

async function setPaused(value) {
  paused = value;
  await chrome.storage.local.set({ paused });
  channel?.send({ event: "paused", paused });
  paintBadge();
  scheduleFlightUpdate();
}

// Let go of one tab. The daemon marks it released, so the agent has to ask before grabbing it again.
async function release(tabId) {
  attached.delete(tabId);
  released.add(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  persistTabs();
  channel?.send({ event: "detached", tabId, reason: "released_by_user" });
}

// Kill switch: let go of every tab, hang up, and stay off until the user reconnects.
async function mayday() {
  await chrome.storage.local.set({ enabled: false });
  await disconnect(); // releases every tab we hold
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    switch (msg.cmd) {
      case "connect":
        retryDelay = 1000;
        if (ws) await disconnect();
        await chrome.storage.local.set({ enabled: true });
        await connect(true);
        break;
      case "disconnect":
        await chrome.storage.local.set({ enabled: false });
        await disconnect();
        break;
      case "wake":
        await connect();
        scheduleFlightUpdate();
        break;
      case "pause":
        await setPaused(true);
        break;
      case "resume":
        await setPaused(false);
        break;
      case "release":
        await release(msg.tabId);
        break;
      case "focus":
        await handlers["tabs.activate"]({ tabId: msg.tabId }).catch(() => {});
        break;
      case "mayday":
        await mayday();
        break;
    }
    reply({ ok: true });
  })();
  return true;
});

// Keyboard shortcuts (rebind at chrome://extensions/shortcuts).
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-pause") setPaused(!paused);
  if (command === "mayday") mayday();
});

// ---------------------------------------------------------------- lifecycle

// Service workers get killed when idle. The alarm wakes us up to reconnect if that happened.
chrome.alarms.create("tabpilot-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "tabpilot-keepalive" && connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

// Restore pause state (it survives service worker restarts and browser restarts) before connecting.
chrome.storage.local.get("paused").then((s) => {
  paused = !!s.paused;
  connect();
});
