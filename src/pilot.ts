import type { Bridge } from "./bridge.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir, hostAllowed, type Config } from "./config.js";
import { log } from "./log.js";

/**
 * One connected MCP client (one Claude Code session, one Cursor window, ...).
 * `key` is stable for the life of the client process (the shim sends it), so after a daemon restart
 * or a browser reconnect the session can find its tab again through its tab group, "tabpilot <label>".
 */
export class Session {
  /** MCP session id. Changes if the shim has to reconnect. */
  id = "";
  tabId: number | null = null;
  groupId: number | null = null;
  /** Did we already try to recover tabId from the browser's tab groups? */
  recovered = false;
  /** Closed by the daemon for being idle, not by the client. The client may come back for its tab. */
  expired = false;
  readonly color: string;
  private static colors = ["blue", "purple", "cyan", "green", "orange", "pink", "yellow", "red"];

  constructor(readonly key: string) {
    let h = 0;
    for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    this.color = Session.colors[h % Session.colors.length];
  }

  get label(): string {
    return this.key.replace(/-/g, "").slice(0, 4);
  }

  /** Page attribute this session's snapshot refs live in, so two sessions on one tab can't clobber each other's refs. */
  get refAttr(): string {
    return `data-tp-${this.label.toLowerCase().replace(/[^a-z0-9]/g, "") || "x"}`;
  }

  get groupTitle(): string {
    return `tabpilot ${this.label}`;
  }

  forgetTab() {
    this.tabId = null;
    this.groupId = null;
    this.recovered = false;
  }
}

export interface Target {
  ref?: string;
  selector?: string;
  text?: string;
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Space: { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  F5: { code: "F5", keyCode: 116 },
};
const PUNCTUATION: Record<string, [string, number]> = {
  ".": ["Period", 190],
  ",": ["Comma", 188],
  "/": ["Slash", 191],
  ";": ["Semicolon", 186],
  "'": ["Quote", 222],
  "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  "-": ["Minus", 189],
  "=": ["Equal", 187],
  "`": ["Backquote", 192],
  " ": ["Space", 32],
};
const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

// ---- scripts that run inside the page (stringified, so no closures) ----

const SNAPSHOT_FN = function (opts: { maxElements: number; maxText: number; includeText: boolean; attr: string }) {
  const SEL =
    'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=slider],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  document.querySelectorAll(`[${opts.attr}]`).forEach((e) => e.removeAttribute(opts.attr));
  const out: string[] = [];
  let n = 0;
  let hidden = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(SEL))) {
    if (n >= opts.maxElements) break;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if ((r.width === 0 && r.height === 0) || cs.visibility === "hidden" || cs.display === "none") {
      hidden++;
      continue;
    }
    const ref = "e" + ++n;
    el.setAttribute(opts.attr, ref);
    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? input.type || "text" : tag);
    const labelledBy = el.getAttribute("aria-labelledby");
    const name = (
      el.getAttribute("aria-label") ||
      (labelledBy && document.getElementById(labelledBy)?.innerText) ||
      (input.labels && input.labels[0]?.innerText) ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.innerText ||
      (tag === "input" && ["submit", "button"].includes(input.type) ? input.value : "") ||
      el.getAttribute("alt") ||
      el.getAttribute("name") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const bits = [`[${ref}]`, role];
    if (name) bits.push(JSON.stringify(name));
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (input.type === "checkbox" || input.type === "radio") bits.push(input.checked ? "checked" : "unchecked");
      else if (input.type === "password") bits.push(input.value ? "value=•••" : "empty");
      else if (input.value && input.value !== name) bits.push("value=" + JSON.stringify(String(input.value).slice(0, 60)));
    }
    if (tag === "a") bits.push("→ " + (el.getAttribute("href") || "").slice(0, 80));
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
    if (el.getAttribute("aria-expanded")) bits.push("expanded=" + el.getAttribute("aria-expanded"));
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) bits.push("(offscreen)");
    out.push(bits.join(" "));
  }
  let text = "";
  if (opts.includeText) {
    text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length > opts.maxText) text = text.slice(0, opts.maxText) + `\n… (${text.length - opts.maxText} more chars; raise maxText to see them)`;
  }
  return {
    url: location.href,
    title: document.title,
    elements: out,
    truncated: n >= opts.maxElements,
    text,
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight },
    iframes: document.querySelectorAll("iframe").length,
  };
};

const LOCATE_FN = function (t: { ref?: string; selector?: string; text?: string; attr: string }) {
  let el: HTMLElement | null = null;
  if (t.ref) el = document.querySelector(`[${t.attr}="${t.ref}"]`);
  else if (t.selector) el = document.querySelector(t.selector);
  else if (t.text) {
    const want = t.text.trim().toLowerCase();
    let best = Infinity;
    const candidates = document.querySelectorAll<HTMLElement>(
      "a,button,input[type=submit],input[type=button],[role=button],[role=link],[role=tab],[role=menuitem],[role=option],label,summary,[onclick]",
    );
    for (const c of Array.from(candidates)) {
      const s = (c.innerText || (c as HTMLInputElement).value || c.getAttribute("aria-label") || "").trim().toLowerCase();
      if (!s.includes(want)) continue;
      const r = c.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const score = s === want ? 0 : s.length;
      if (score < best) {
        best = score;
        el = c;
      }
    }
  }
  if (!el) {
    return {
      error: t.ref
        ? `No element with ref ${t.ref}. Refs reset on every snapshot and navigation, so take a fresh snapshot.`
        : `Nothing on the page matches ${t.selector ? "selector " + JSON.stringify(t.selector) : "text " + JSON.stringify(t.text)}.`,
    };
  }
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  let covered: string | undefined;
  if (top && top !== el && !el.contains(top) && !top.contains(el)) {
    covered = top.tagName.toLowerCase() + (top.id ? "#" + top.id : "") + (top.className && typeof top.className === "string" ? "." + top.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
  }
  return { x, y, width: r.width, height: r.height, pageX: r.left + scrollX, pageY: r.top + scrollY, tag: el.tagName.toLowerCase(), covered };
};

const IDLE_DETACH_MS = 15 * 60_000;

/**
 * The shared brain behind every MCP session: owns debugger attachments, translates
 * high-level actions into CDP calls, and keeps sessions from tripping over each other.
 */
export class Pilot {
  /** tabId -> MCP session ids currently using it. The debugger detaches when nobody is left. */
  private attachments = new Map<number, Set<string>>();
  /** In-flight attaches, so two sessions grabbing the same tab at once share one attach. */
  private attaching = new Map<number, Promise<void>>();
  /** Last time any session touched each attached tab. Idle tabs get let go. */
  private lastUsed = new Map<number, number>();
  /** Tabs the user took back. The extension enforces this too; we keep a copy for clear error messages. */
  private released = new Set<number>();
  readonly sessions = new Map<string, Session>();
  /** Dialogs we couldn't answer yet (the user had paused us). Answered on resume. */
  private pendingDialogs = new Map<number, any>();
  /** client key -> the tab it was driving, so a daemon restart picks up the right tab (not just any tab in its group). */
  private savedTabs: Record<string, { tabId: number; instance: string | null; at?: number }> = {};

  constructor(
    readonly bridge: Bridge,
    readonly cfg: Config,
  ) {
    bridge.on("detached", (tabId: number, reason: string) => {
      this.attachments.delete(tabId);
      if (reason === "canceled_by_user" || reason === "released_by_user") {
        this.released.add(tabId);
        this.bridge.recorder(tabId).pushConsole({ ts: Date.now(), level: "tabpilot", text: "the user took the controls back for this tab" });
        log(`user released tab ${tabId}`);
      }
    });
    bridge.on("tabRemoved", (tabId: number) => {
      this.attachments.delete(tabId);
      this.released.delete(tabId);
      this.lastUsed.delete(tabId);
      for (const s of this.sessions.values()) if (s.tabId === tabId) s.tabId = null;
    });
    // The extension detaches everything when the connection drops, so our view starts clean next time.
    bridge.on("disconnected", () => {
      this.attachments.clear();
      this.attaching.clear();
    });
    // A different browser (or a restarted one) means every tab id we hold could point at the wrong tab.
    bridge.on("newBrowser", () => {
      this.released.clear();
      this.lastUsed.clear();
      for (const s of this.sessions.values()) s.forgetTab();
    });
    // alert()/confirm()/prompt() freeze the page until someone answers. We answer, and write it down.
    // Only for tabs a session is actually driving: tabs we've let go of are the user's business.
    bridge.on("cdp", (tabId: number, method: string, p: any) => {
      if (method !== "Page.javascriptDialogOpening") return;
      if (!this.attachments.has(tabId) && !this.attaching.has(tabId)) return;
      this.pendingDialogs.set(tabId, p);
      this.answerDialog(tabId);
    });
    bridge.on("paused", (paused: boolean) => {
      if (!paused) for (const tabId of this.pendingDialogs.keys()) this.answerDialog(tabId);
    });
    try {
      this.savedTabs = JSON.parse(readFileSync(join(homeDir(), "sessions.json"), "utf8"));
    } catch {
      this.savedTabs = {};
    }
    // Sessions that vanish without saying goodbye (killed client, crashed shim) would leave Chrome's
    // "being debugged" bar up forever. Let go of tabs nobody has touched in a while.
    setInterval(() => this.detachIdle(), 60_000).unref();
  }

  private answerDialog(tabId: number) {
    const p = this.pendingDialogs.get(tabId);
    if (!p) return;
    this.bridge
      .call("cdp", { tabId, method: "Page.handleJavaScriptDialog", params: { accept: true, promptText: p.defaultPrompt ?? "" } })
      .then(() => {
        this.pendingDialogs.delete(tabId);
        this.bridge.recorder(tabId).pushConsole({ ts: Date.now(), level: "dialog", text: `${p.type}(${JSON.stringify(p.message)}) → auto-accepted` });
      })
      .catch((e) => {
        // Paused: we'll answer on resume. Anything else (dialog already gone, tab closed): forget it.
        if (!this.bridge.paused) this.pendingDialogs.delete(tabId);
        void e;
      });
  }

  /** Make tabId this session's current tab, and let go of the one it was driving before. */
  async setTab(s: Session, tabId: number) {
    const old = s.tabId;
    s.tabId = tabId;
    this.savedTabs[s.key] = { tabId, instance: this.bridge.instanceId, at: Date.now() };
    this.saveTabs();
    if (old !== null && old !== tabId) await this.release(s, old);
  }

  private async release(s: Session, tabId: number) {
    await this.attaching.get(tabId)?.catch(() => {}); // let an in-flight attach land first, then undo it
    const users = this.attachments.get(tabId);
    if (!users) return;
    users.delete(s.id);
    if (users.size === 0) {
      this.attachments.delete(tabId);
      this.lastUsed.delete(tabId);
      this.pendingDialogs.delete(tabId);
      await this.bridge.call("debugger.detach", { tabId }).catch(() => {});
    }
  }

  private saveTabs() {
    // Every shim process gets a fresh key, so keep this small: only the most recent sessions matter.
    const keys = Object.keys(this.savedTabs);
    if (keys.length > 50) {
      keys.sort((a, b) => (this.savedTabs[b].at ?? 0) - (this.savedTabs[a].at ?? 0));
      for (const k of keys.slice(50)) delete this.savedTabs[k];
    }
    try {
      writeFileSync(join(homeDir(), "sessions.json"), JSON.stringify(this.savedTabs));
    } catch {
      /* not worth failing a tool call over */
    }
  }

  private async detachIdle() {
    const now = Date.now();
    for (const [tabId, at] of this.lastUsed) {
      if (now - at < IDLE_DETACH_MS || !this.attachments.has(tabId)) continue;
      this.attachments.delete(tabId);
      this.lastUsed.delete(tabId);
      await this.bridge.call("debugger.detach", { tabId }).catch(() => {});
      this.bridge.recorder(tabId).pushConsole({
        ts: now,
        level: "tabpilot",
        text: `let go of this tab after ${IDLE_DETACH_MS / 60_000} idle minutes; console/network recording paused until the next tool call`,
      });
      log(`released idle tab ${tabId}`);
    }
  }

  async closeSession(s: Session) {
    this.sessions.delete(s.id);
    // A clean goodbye means nobody will come back for this tab. (Crashes and daemon restarts keep the entry.)
    if (!s.expired && this.savedTabs[s.key]) {
      delete this.savedTabs[s.key];
      this.saveTabs();
    }
    for (const [tabId, users] of this.attachments) {
      users.delete(s.id);
      if (users.size === 0) {
        this.attachments.delete(tabId);
        this.lastUsed.delete(tabId);
        await this.bridge.call("debugger.detach", { tabId }).catch(() => {});
      }
    }
  }

  /** Pages Chrome won't let any extension debug, or won't open from the debugger. Say so up front. */
  checkNavigable(url: string) {
    const scheme = url.slice(0, url.indexOf(":") + 1).toLowerCase();
    if (/^(chrome|chrome-extension|chrome-untrusted|devtools|edge|brave|opera|vivaldi|view-source):$/.test(scheme) || (scheme === "about:" && !/^about:blank$/i.test(url))) {
      throw new Error(`${url} is a browser page, and Chrome doesn't let extensions drive those. Use a regular web page.`);
    }
    if (scheme === "data:" || scheme === "javascript:") {
      throw new Error(`Chrome blocks opening ${scheme} URLs in a tab. Open a real page (even about:blank) and build content with evaluate instead.`);
    }
  }

  checkAllowed(url: string) {
    if (!hostAllowed(this.cfg, url)) {
      throw new Error(`${url} isn't on the allow-list (${this.cfg.allow.join(", ")}). Edit "allow" in ~/.tabpilot/config.json to change that.`);
    }
  }

  async attach(s: Session, tabId: number, force = false) {
    if (force) this.released.delete(tabId);
    if (this.released.has(tabId)) {
      throw new Error(
        `The user took back tab ${tabId} (released it in the extension or canceled Chrome's debugging bar). Ask them before grabbing it again, then call tab_select with force: true.`,
      );
    }
    if (!this.attachments.has(tabId)) {
      let pending = this.attaching.get(tabId);
      if (!pending) {
        pending = (async () => {
          await this.bridge.call("debugger.attach", { tabId, force });
          const send = (method: string, params = {}) => this.bridge.call("cdp", { tabId, method, params });
          await Promise.all([
            send("Page.enable"),
            send("Page.setLifecycleEventsEnabled", { enabled: true }),
            send("Runtime.enable"),
            send("Log.enable"),
            send("Network.enable"),
          ]);
          this.attachments.set(tabId, new Set());
        })().finally(() => this.attaching.delete(tabId));
        this.attaching.set(tabId, pending);
      }
      await pending;
    }
    this.attachments.get(tabId)?.add(s.id);
    this.lastUsed.set(tabId, Date.now());
  }

  /** The session's current tab. After a reconnect, finds it again via the session's tab group. */
  async tab(s: Session): Promise<number> {
    if (s.tabId === null && !s.recovered && this.bridge.connected) {
      s.recovered = true;
      const saved = this.savedTabs[s.key];
      if (saved && saved.instance && saved.instance === this.bridge.instanceId) {
        const t = await this.bridge.call<any>("tabs.get", { tabId: saved.tabId }).catch(() => null);
        if (t) {
          s.tabId = saved.tabId;
          // The saved tab may be one of the user's (tab_select). Only reuse *our* group, never theirs.
          const ours = await this.bridge.call<{ groupId: number } | null>("groups.find", { title: s.groupTitle }).catch(() => null);
          s.groupId = ours?.groupId ?? null;
          log(`session ${s.label} picked up where it left off on tab ${saved.tabId}`);
          return s.tabId;
        }
      }
      const found = await this.bridge.call<{ groupId: number; tabId: number } | null>("groups.find", { title: s.groupTitle }).catch(() => null);
      if (found) {
        s.groupId = found.groupId;
        s.tabId = found.tabId;
        log(`session ${s.label} found its way back to tab ${found.tabId}`);
      }
    }
    if (s.tabId === null) throw new Error("No tab selected yet. Use tab_open to open one, or tabs_list + tab_select to grab an existing tab.");
    return s.tabId;
  }

  async cdp<T = any>(s: Session, method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const tabId = await this.tab(s);
    if (!this.attachments.get(tabId)?.has(s.id)) await this.attach(s, tabId);
    this.lastUsed.set(tabId, Date.now());
    try {
      return await this.bridge.call<T>("cdp", { tabId, method, params }, timeoutMs);
    } catch (e: any) {
      // We thought we were attached but the browser disagrees (the user just released it, or Chrome
      // detached on its own). Forget the attachment and try once more; attach() reports a release properly.
      if (!/not attached/i.test(String(e?.message))) throw e;
      this.attachments.delete(tabId);
      await this.attach(s, tabId);
      return this.bridge.call<T>("cdp", { tabId, method, params }, timeoutMs);
    }
  }

  /** Run JS in the page and hand back the value. Throws with the page's own error message. */
  async evaluate<T = any>(s: Session, expression: string, timeoutMs = 30_000): Promise<T> {
    const r = await this.cdp(s, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true, timeout: timeoutMs }, timeoutMs + 2000);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? "evaluation failed");
    }
    return r.result?.value as T;
  }

  call<T>(s: Session, fn: Function, arg: unknown): Promise<T> {
    return this.evaluate<T>(s, `(${fn.toString()})(${JSON.stringify(arg)})`);
  }

  snapshot(s: Session, opts: { maxElements: number; maxText: number; includeText: boolean }) {
    return this.call<any>(s, SNAPSHOT_FN, { ...opts, attr: s.refAttr });
  }

  async locate(s: Session, t: Target) {
    if (!t.ref && !t.selector && !t.text) throw new Error("Tell me what to target: ref (from snapshot), selector, or text.");
    const r = await this.call<any>(s, LOCATE_FN, { ...t, attr: s.refAttr });
    if (r.error) throw new Error(r.error);
    return r as { x: number; y: number; width: number; height: number; pageX: number; pageY: number; tag: string; covered?: string };
  }

  /**
   * Run a navigation and wait for it to land. Tracks the navigation by loaderId, so a load event from an
   * earlier navigation can't fool it, and same-document navigations (hash changes, SPA history) return
   * right away instead of waiting for a load event that never comes.
   * `trigger` may return Page.navigate's result ({loaderId, errorText}).
   */
  async navigate(s: Session, trigger: () => Promise<any>, timeoutMs: number, opts: { crossDocument?: boolean } = {}): Promise<"loaded" | "same-document" | "timeout" | "http-error"> {
    const tabId = await this.tab(s);
    const tree = await this.cdp(s, "Page.getFrameTree");
    const mainId: string = tree.frameTree.frame.id;
    const oldLoader: string = tree.frameTree.frame.loaderId;
    let expected: string | undefined;
    // The old page can pushState on its way out (Google does), which fires navigatedWithinDocument
    // while the real cross-document navigation is still in flight. So don't trust that event until
    // we know what kind of navigation this is.
    let triggered = false;
    let sawSameDoc = false;
    const wait = this.bridge.waitFor<"loaded" | "same-document">(
      tabId,
      (m, p) => {
        // Back/forward from the bfcache restores the old page without a fresh load event.
        if (m === "Page.frameNavigated" && p?.frame?.id === mainId && p.type === "BackForwardCacheRestore") return "loaded";
        // The site (or a redirect it did) couldn't load and Chrome swapped in its error page. That's the end of the road.
        if (m === "Page.frameNavigated" && p?.frame?.id === mainId && String(p.frame.url ?? "").startsWith("chrome-error://")) return "loaded";
        if (p?.frameId !== mainId) return undefined;
        if (m === "Page.lifecycleEvent" && p.name === "load" && p.loaderId !== oldLoader && (!expected || p.loaderId === expected)) return "loaded";
        if (m === "Page.navigatedWithinDocument" && !opts.crossDocument) {
          if (!triggered) sawSameDoc = true;
          else if (!expected) return "same-document";
        }
        return undefined;
      },
      timeoutMs,
    );
    wait.promise.catch(() => {}); // early exits below never await it; don't leave a rejection hanging
    try {
      const r = await trigger();
      triggered = true;
      if (r?.errorText === "net::ERR_HTTP_RESPONSE_CODE_FAILURE") {
        // The server answered 4xx/5xx with an empty body. That's a page, not a crash: Chrome shows its error page.
        expected = r.loaderId;
        const t = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), Math.min(timeoutMs, 5000)));
        await Promise.race([wait.promise, t]).catch(() => {});
        wait.cancel();
        return "http-error";
      }
      if (r?.errorText === "net::ERR_ABORTED") {
        const still = await this.bridge.call("tabs.get", { tabId }).catch(() => null);
        throw new Error(
          still
            ? "That navigation didn't produce a page: it was a download, an empty 204 response, or another navigation canceled it."
            : "The tab was closed while it was loading.",
        );
      }
      if (r?.errorText === "net::ERR_BLOCKED_BY_CLIENT") throw new Error("The browser blocked that page (an ad blocker or another extension, most likely).");
      if (r?.errorText) throw new Error(`Navigation failed: ${r.errorText}`);
      if (r && "frameId" in r) {
        // Page.navigate tells us directly: a loaderId means a new document is coming.
        if (!r.loaderId) {
          wait.cancel();
          return "same-document";
        }
        expected = r.loaderId;
      } else if (sawSameDoc && !opts.crossDocument) {
        wait.cancel();
        return "same-document";
      }
      return await wait.promise;
    } catch (e) {
      wait.cancel();
      throw e;
    }
  }

  /** Navigate without CDP (for tabs sitting on a page we can't debug), then take the controls again. */
  async navigatePlain(s: Session, url: string, timeoutMs: number): Promise<"loaded" | "timeout"> {
    const tabId = await this.tab(s);
    if (this.released.has(tabId)) {
      throw new Error(`The user took back tab ${tabId}. Ask them before grabbing it again, then call tab_select with force: true.`);
    }
    const before = await this.bridge.call<any>("tabs.get", { tabId });
    await this.bridge.call("tabs.navigate", { tabId, url });
    const deadline = Date.now() + timeoutMs;
    let t: any;
    do {
      await new Promise((r) => setTimeout(r, 250));
      t = await this.bridge.call<any>("tabs.get", { tabId });
      // Don't take the old page's "complete" for the new one.
    } while ((t.status !== "complete" || t.url === before.url) && Date.now() < deadline);
    const landed = t.status === "complete" && t.url !== before.url;
    if (!landed && /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|brave|view-source|about):/i.test(t.url) && t.url !== "about:blank") {
      throw new Error(`The page didn't load within ${timeoutMs}ms, and the tab is still on ${t.url}, which Chrome won't let extensions drive.`);
    }
    await this.attach(s, tabId);
    return landed ? "loaded" : "timeout";
  }

  async mouse(s: Session, x: number, y: number, opts: { button?: string; clickCount?: number; modifiers?: number; hoverOnly?: boolean } = {}) {
    const base = { x, y, modifiers: opts.modifiers ?? 0 };
    await this.cdp(s, "Input.dispatchMouseEvent", { type: "mouseMoved", ...base });
    if (opts.hoverOnly) return;
    const button = opts.button ?? "left";
    for (let i = 1; i <= (opts.clickCount ?? 1); i++) {
      await this.cdp(s, "Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: i, ...base });
      await this.cdp(s, "Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount: i, ...base });
    }
  }

  /** Press a key or combo like "Enter", "Control+a", "Shift+Tab", "Meta+k", ".", "Shift+a". */
  async press(s: Session, combo: string) {
    let parts: string[];
    let keyName: string;
    if (combo === " " || combo === "+") {
      parts = [];
      keyName = combo;
    } else if (combo.endsWith("++")) {
      parts = combo.slice(0, -2).split("+").map((p) => p.trim()).filter(Boolean);
      keyName = "+";
    } else {
      parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
      keyName = parts.pop() ?? "";
    }
    let modifiers = 0;
    for (const m of parts) {
      const bit = MODIFIERS[m.toLowerCase()];
      if (bit === undefined) throw new Error(`Unknown modifier "${m}". Use Control, Shift, Alt or Meta.`);
      modifiers |= bit;
    }
    const knownName = KEYS[keyName] ? keyName : Object.keys(KEYS).find((k) => k.toLowerCase() === keyName.toLowerCase());
    if (knownName) keyName = knownName;
    const known = knownName ? KEYS[knownName] : undefined;
    let key: string, code: string, keyCode: number, text: string | undefined;
    if (known) {
      key = keyName === "Space" ? " " : keyName;
      ({ code, keyCode, text } = known);
      if (modifiers & (1 | 2 | 4)) text = undefined; // Control+Enter is a shortcut, not a newline
    } else if (keyName.length === 1) {
      key = keyName;
      if (/[a-z]/i.test(keyName)) {
        const upper = keyName.toUpperCase();
        code = `Key${upper}`;
        keyCode = upper.charCodeAt(0);
        if (modifiers & 8) key = upper; // Shift+a types "A"
      } else if (/[0-9]/.test(keyName)) {
        code = `Digit${keyName}`;
        keyCode = keyName.charCodeAt(0);
        if (modifiers & 8) key = ")!@#$%^&*("[Number(keyName)]; // US layout: Shift+1 types "!"
      } else if (PUNCTUATION[keyName]) {
        [code, keyCode] = PUNCTUATION[keyName];
      } else {
        code = ""; // shifted symbols like ! or @: the text is what matters
        keyCode = 0;
      }
      // Only plain (or shifted) typing produces text; Control+a should select-all, not type "a".
      text = modifiers & ~8 ? undefined : key;
    } else {
      throw new Error(`Unknown key "${keyName}". Try Enter, Tab, Escape, Backspace, ArrowDown, or a single character.`);
    }
    const commands: string[] = [];
    if (modifiers & (2 | 4) && key.toLowerCase() === "a") commands.push("selectAll");
    await this.cdp(s, "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers, text, commands });
    await this.cdp(s, "Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers });
  }

  /** Background tabs can't paint, so screenshots of them hang. Bring the tab forward if it's hidden. */
  // Background tabs don't paint, and a freshly opened tab can report a 0x0 viewport for a beat
  // before Chrome lays it out. Bring it forward if needed, then wait (briefly) for a real size.
  async ensureVisible(s: Session, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    let activated = false;
    for (;;) {
      const v = await this.evaluate<{ vis: string; w: number; h: number }>(
        s,
        "({vis: document.visibilityState, w: innerWidth, h: innerHeight})",
      ).catch(() => ({ vis: "visible", w: 1, h: 1 }));
      if (v.vis === "visible" && v.w > 0 && v.h > 0) return;
      if (!activated && v.vis !== "visible") {
        await this.bridge.call("tabs.activate", { tabId: await this.tab(s) });
        activated = true;
      }
      if (Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
