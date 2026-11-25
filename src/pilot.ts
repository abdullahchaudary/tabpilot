import type { Bridge } from "./bridge.js";
import { hostAllowed, type Config } from "./config.js";
import { log } from "./log.js";

/** One connected MCP client (one Claude Code session, one Cursor window, ...). */
export class Session {
  id = "";
  tabId: number | null = null;
  groupId: number | null = null;
  readonly color: string;
  private static count = 0;
  private static colors = ["blue", "purple", "cyan", "green", "orange", "pink", "yellow", "red"];

  constructor() {
    this.color = Session.colors[Session.count++ % Session.colors.length];
  }

  get label(): string {
    return this.id.slice(0, 4);
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
const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

// ---- scripts that run inside the page (stringified, so no closures) ----

const SNAPSHOT_FN = function (opts: { maxElements: number; maxText: number; includeText: boolean }) {
  const SEL =
    'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=slider],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  document.querySelectorAll("[data-tp-ref]").forEach((e) => e.removeAttribute("data-tp-ref"));
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
    el.setAttribute("data-tp-ref", ref);
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

const LOCATE_FN = function (t: { ref?: string; selector?: string; text?: string }) {
  let el: HTMLElement | null = null;
  if (t.ref) el = document.querySelector(`[data-tp-ref="${t.ref}"]`);
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

/**
 * The shared brain behind every MCP session: owns debugger attachments, translates
 * high-level actions into CDP calls, and keeps sessions from tripping over each other.
 */
export class Pilot {
  /** tabId -> sessions currently using it. The debugger detaches when nobody is left. */
  private attachments = new Map<number, Set<string>>();
  /** Tabs where the user hit "Cancel" on Chrome's debugging bar. We don't sneak back in. */
  private released = new Set<number>();
  readonly sessions = new Map<string, Session>();

  constructor(
    readonly bridge: Bridge,
    readonly cfg: Config,
  ) {
    bridge.on("detached", (tabId: number, reason: string) => {
      this.attachments.delete(tabId);
      if (reason === "canceled_by_user") {
        this.released.add(tabId);
        this.bridge.recorder(tabId).pushConsole({ ts: Date.now(), level: "tabpilot", text: "the user took the controls back (debugger canceled)" });
        log(`user released tab ${tabId}`);
      }
    });
    bridge.on("tabRemoved", (tabId: number) => {
      this.attachments.delete(tabId);
      this.released.delete(tabId);
      for (const s of this.sessions.values()) if (s.tabId === tabId) s.tabId = null;
    });
    bridge.on("disconnected", () => this.attachments.clear());
    // alert()/confirm()/prompt() freeze the page until someone answers. We answer, and write it down.
    bridge.on("cdp", (tabId: number, method: string, p: any) => {
      if (method !== "Page.javascriptDialogOpening") return;
      this.bridge
        .call("cdp", { tabId, method: "Page.handleJavaScriptDialog", params: { accept: true, promptText: p.defaultPrompt ?? "" } })
        .catch(() => {});
      this.bridge.recorder(tabId).pushConsole({ ts: Date.now(), level: "dialog", text: `${p.type}(${JSON.stringify(p.message)}) → auto-accepted` });
    });
  }

  async closeSession(s: Session) {
    this.sessions.delete(s.id);
    for (const [tabId, users] of this.attachments) {
      users.delete(s.id);
      if (users.size === 0) {
        this.attachments.delete(tabId);
        await this.bridge.call("debugger.detach", { tabId }).catch(() => {});
      }
    }
  }

  checkAllowed(url: string) {
    if (!hostAllowed(this.cfg, url)) {
      throw new Error(`${url} isn't on the allow-list (${this.cfg.allow.join(", ")}). Edit "allow" in ~/.tabpilot/config.json to change that.`);
    }
  }

  async attach(s: Session, tabId: number) {
    if (this.released.has(tabId)) {
      throw new Error(`The user took back tab ${tabId} (they canceled the debugger bar). Ask them before grabbing it again, then call tab_select with force: true.`);
    }
    let users = this.attachments.get(tabId);
    if (!users) {
      await this.bridge.call("debugger.attach", { tabId });
      users = new Set();
      this.attachments.set(tabId, users);
      const send = (method: string, params = {}) => this.bridge.call("cdp", { tabId, method, params });
      await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Log.enable"), send("Network.enable")]);
    }
    users.add(s.id);
  }

  unrelease(tabId: number) {
    this.released.delete(tabId);
  }

  tab(s: Session): number {
    if (s.tabId === null) throw new Error("No tab selected yet. Use tab_open to open one, or tabs_list + tab_select to grab an existing tab.");
    return s.tabId;
  }

  async cdp<T = any>(s: Session, method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const tabId = this.tab(s);
    if (!this.attachments.get(tabId)?.has(s.id)) await this.attach(s, tabId);
    return this.bridge.call<T>("cdp", { tabId, method, params }, timeoutMs);
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
    return this.call<any>(s, SNAPSHOT_FN, opts);
  }

  async locate(s: Session, t: Target) {
    if (!t.ref && !t.selector && !t.text) throw new Error("Tell me what to target: ref (from snapshot), selector, or text.");
    const r = await this.call<any>(s, LOCATE_FN, t);
    if (r.error) throw new Error(r.error);
    return r as { x: number; y: number; width: number; height: number; pageX: number; pageY: number; tag: string; covered?: string };
  }

  async waitForLoad(s: Session, trigger: () => Promise<unknown>, timeoutMs: number): Promise<"loaded" | "timeout"> {
    const tabId = this.tab(s);
    const loaded = this.bridge.waitForEvent(tabId, "Page.loadEventFired", timeoutMs).then(
      () => "loaded" as const,
      () => "timeout" as const,
    );
    await trigger();
    return loaded;
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

  /** Press a key or combo like "Enter", "Control+a", "Shift+Tab", "Meta+k". */
  async press(s: Session, combo: string) {
    const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
    let keyName = parts.pop() ?? "";
    if (keyName === "" && combo.endsWith("+")) keyName = "+";
    let modifiers = 0;
    for (const m of parts) {
      const bit = MODIFIERS[m.toLowerCase()];
      if (bit === undefined) throw new Error(`Unknown modifier "${m}". Use Control, Shift, Alt or Meta.`);
      modifiers |= bit;
    }
    const known = KEYS[keyName] ?? KEYS[keyName.charAt(0).toUpperCase() + keyName.slice(1)];
    let key: string, code: string, keyCode: number, text: string | undefined;
    if (known) {
      key = keyName === "Space" ? " " : keyName;
      ({ code, keyCode, text } = known);
    } else if (keyName.length === 1) {
      key = keyName;
      const upper = keyName.toUpperCase();
      keyCode = upper.charCodeAt(0);
      code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(keyName) ? `Digit${keyName}` : "";
      // Only plain typing produces text; Control+a should select-all, not type "a".
      text = modifiers & ~8 ? undefined : keyName;
    } else {
      throw new Error(`Unknown key "${keyName}". Try Enter, Tab, Escape, Backspace, ArrowDown, or a single character.`);
    }
    const commands: string[] = [];
    if (modifiers & 2 && key.toLowerCase() === "a") commands.push("selectAll");
    await this.cdp(s, "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers, text, commands });
    await this.cdp(s, "Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers });
  }

  /** Background tabs can't paint, so screenshots of them hang. Bring the tab forward if it's hidden. */
  async ensureVisible(s: Session) {
    const state = await this.evaluate<string>(s, "document.visibilityState").catch(() => "visible");
    if (state !== "visible") {
      await this.bridge.call("tabs.activate", { tabId: this.tab(s) });
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
