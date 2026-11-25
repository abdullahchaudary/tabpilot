import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { NetworkEntry } from "./bridge.js";
import type { Pilot, Session, Target } from "./pilot.js";
import { VERSION } from "./version.js";

const INSTRUCTIONS = `tabpilot gives you a real, visible browser (the user's own Chrome/Edge/Brave) through an extension.

How to fly it:
1. tab_open a URL (or tabs_list + tab_select to grab a tab the user already has open).
2. snapshot to see the page: every interactive element gets a ref like e12.
3. Act with click / type / press / select_option / hover / scroll, targeting by ref (best), CSS selector, or visible text.
4. After actions, check console and network for errors. That's the whole point of testing in a real browser.
5. screenshot when layout or visuals matter; snapshot is cheaper for everything else.

Refs reset on every snapshot and navigation, so re-snapshot after the page changes.
Console and network are recorded from the moment tabpilot attaches; reload to capture a page's startup logs.
alert/confirm/prompt dialogs are auto-accepted and logged to the console as "dialog" entries.
Use evaluate for anything custom, and cdp for raw Chrome DevTools Protocol access.`;

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });

const targetShape = {
  ref: z.string().optional().describe("Element ref from the latest snapshot, e.g. e12. Most reliable."),
  selector: z.string().optional().describe("CSS selector, if you know the markup."),
  text: z.string().optional().describe("Visible text of a button/link/label, e.g. 'Sign in'."),
};

function fmtTime(ts: number) {
  return new Date(ts).toISOString().slice(11, 23);
}

function fmtBytes(n?: number) {
  if (n === undefined) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function clip(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
}

function networkLine(e: NetworkEntry) {
  const status = e.failed ? `✗ ${e.failed}` : e.status ?? (e.done ? "?" : "…");
  const dur = e.durationMs !== undefined ? `${e.durationMs}ms` : "";
  return `#${e.seq} ${e.method} ${status} ${e.type ?? ""} ${fmtBytes(e.size)} ${dur} ${e.url}`.replace(/\s+/g, " ");
}

/** Build the MCP server for one session. Every tool closes over that session's state. */
export function createMcpServer(pilot: Pilot, s: Session): McpServer {
  const server = new McpServer({ name: "tabpilot", version: VERSION }, { instructions: INSTRUCTIONS });
  const bridge = pilot.bridge;

  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {},
  ) => server.registerTool(name, { description, inputSchema: shape, annotations }, handler as any);

  // ---------------------------------------------------------------- cockpit

  tool(
    "status",
    "Is a browser connected, which tab am I driving, and what's the setup. Cheap; call it when something feels off.",
    {},
    async () => {
      if (!bridge.connected) {
        return text("✗ No browser connected.\nAsk the user to open the tabpilot extension popup, paste the pairing code (run `tabpilot pair` to see it), and hit Connect.");
      }
      const i = bridge.browserInfo;
      const lines = [
        `✓ Browser connected${i.remote && !/127\.0\.0\.1|::1/.test(i.remote) ? ` from ${i.remote}` : ""}`,
        `  ${i.userAgent ?? ""}`,
        `  extension v${i.extensionVersion ?? "?"}, daemon v${VERSION}`,
        `  sessions flying: ${pilot.sessions.size}`,
        `  allow-list: ${pilot.cfg.allow.length ? pilot.cfg.allow.join(", ") : "off (any site)"}`,
      ];
      if (s.tabId !== null) {
        const t = await bridge.call<any>("tabs.get", { tabId: s.tabId }).catch(() => null);
        lines.push(t ? `  current tab: ${t.id} ${t.title} (${t.url})` : "  current tab: gone");
      } else lines.push("  current tab: none yet (tab_open or tab_select)");
      return text(lines.join("\n"));
    },
    { readOnlyHint: true },
  );

  // ---------------------------------------------------------------- tabs

  tool(
    "tabs_list",
    "List every open tab in the browser, with ids. ▸ marks the tab you're driving.",
    {},
    async () => {
      const tabs = await bridge.call<any[]>("tabs.list");
      const lines = tabs.map((t) => `${t.id === s.tabId ? "▸" : " "} ${t.id}  ${t.title || "(untitled)"}  ${t.url}${t.active ? "  [visible]" : ""}`);
      return text(lines.join("\n") || "No tabs.");
    },
    { readOnlyHint: true },
  );

  tool(
    "tab_open",
    "Open a new tab (in this session's tab group) and make it the current tab. Console/network recording starts before the page loads.",
    {
      url: z.string().describe("Where to go. Bare hosts like localhost:3000 get http:// added."),
      background: z.boolean().optional().describe("Open without stealing focus. Default false."),
    },
    async ({ url, background }) => {
      const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `http://${url}`;
      pilot.checkAllowed(target);
      const created = await bridge.call<{ tabId: number; groupId: number | null }>("tabs.create", {
        active: !background,
        groupId: s.groupId,
        groupTitle: `tabpilot ${s.label}`,
        groupColor: s.color,
      });
      s.groupId = created.groupId;
      s.tabId = created.tabId;
      await pilot.attach(s, created.tabId);
      let errorText: string | undefined;
      const result = await pilot.waitForLoad(
        s,
        async () => {
          const r = await pilot.cdp(s, "Page.navigate", { url: target });
          errorText = r.errorText;
        },
        20_000,
      );
      if (errorText) return text(`Opened tab ${created.tabId}, but loading ${target} failed: ${errorText}`);
      const title = await pilot.evaluate<string>(s, "document.title").catch(() => "");
      return text(`Opened tab ${created.tabId}: ${title || target}${result === "timeout" ? " (still loading after 20s)" : ""}\nNext: snapshot to see what's on the page.`);
    },
  );

  tool(
    "tab_select",
    "Take control of an existing tab (from tabs_list) and make it the current tab.",
    {
      tabId: z.number().int(),
      focus: z.boolean().optional().describe("Also bring it to the front for the user to see. Default false."),
      force: z.boolean().optional().describe("Re-grab a tab the user explicitly released. Only after they said yes."),
    },
    async ({ tabId, focus, force }) => {
      const t = await bridge.call<any>("tabs.get", { tabId });
      pilot.checkAllowed(t.url);
      if (force) pilot.unrelease(tabId);
      await pilot.attach(s, tabId);
      s.tabId = tabId;
      if (focus) await bridge.call("tabs.activate", { tabId });
      return text(`Now driving tab ${tabId}: ${t.title} (${t.url}).\nHeads up: console/network history starts now. Use navigate with action "reload" to capture startup logs.`);
    },
  );

  tool(
    "tab_close",
    "Close a tab. Defaults to the current tab.",
    { tabId: z.number().int().optional() },
    async ({ tabId }) => {
      const id = tabId ?? pilot.tab(s);
      await bridge.call("tabs.close", { tabId: id });
      if (s.tabId === id) s.tabId = null;
      return text(`Closed tab ${id}.`);
    },
    { destructiveHint: true },
  );

  // ---------------------------------------------------------------- navigation

  tool(
    "navigate",
    "Go to a URL in the current tab, or go back / forward / reload. Waits for the load event.",
    {
      url: z.string().optional(),
      action: z.enum(["back", "forward", "reload", "hard-reload"]).optional(),
      timeoutMs: z.number().int().max(120_000).optional().describe("How long to wait for load. Default 20000."),
    },
    async ({ url, action, timeoutMs = 20_000 }) => {
      let errorText: string | undefined;
      let trigger: () => Promise<unknown>;
      if (url) {
        const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `http://${url}`;
        pilot.checkAllowed(target);
        trigger = async () => {
          const r = await pilot.cdp(s, "Page.navigate", { url: target });
          errorText = r.errorText;
        };
      } else if (action === "reload" || action === "hard-reload") {
        trigger = () => pilot.cdp(s, "Page.reload", { ignoreCache: action === "hard-reload" });
      } else if (action === "back" || action === "forward") {
        const h = await pilot.cdp(s, "Page.getNavigationHistory");
        const entry = h.entries[h.currentIndex + (action === "back" ? -1 : 1)];
        if (!entry) return text(`Nothing to go ${action} to.`);
        trigger = () => pilot.cdp(s, "Page.navigateToHistoryEntry", { entryId: entry.id });
      } else {
        throw new Error("Give me a url or an action (back, forward, reload, hard-reload).");
      }
      const result = await pilot.waitForLoad(s, trigger, timeoutMs);
      if (errorText) throw new Error(`Navigation failed: ${errorText}`);
      const where = await pilot.evaluate<{ url: string; title: string }>(s, "({url: location.href, title: document.title})").catch(() => null);
      return text(`${result === "timeout" ? `Still loading after ${timeoutMs}ms, but here's where we are` : "Loaded"}: ${where?.title ?? ""} (${where?.url ?? url})`);
    },
  );

  // ---------------------------------------------------------------- eyes

  tool(
    "snapshot",
    "Read the current page: title, URL, every visible interactive element with a ref (e1, e2, ...) to target in other tools, plus the page text. Your main way of seeing.",
    {
      includeText: z.boolean().optional().describe("Include the page's visible text. Default true."),
      maxText: z.number().int().optional().describe("Max chars of page text. Default 6000."),
      maxElements: z.number().int().optional().describe("Max interactive elements. Default 250."),
    },
    async ({ includeText = true, maxText = 6000, maxElements = 250 }) => {
      const snap = await pilot.snapshot(s, { includeText, maxText, maxElements });
      const out = [
        `${snap.title || "(untitled)"} | ${snap.url}`,
        `scroll ${snap.scroll.y}/${Math.max(0, snap.scroll.height - snap.scroll.viewport)}px${snap.iframes ? ` | ${snap.iframes} iframe(s), not included` : ""}`,
        "",
        "Interactive elements:",
        ...(snap.elements.length ? snap.elements : ["(none)"]),
      ];
      if (snap.truncated) out.push(`… more elements exist; raise maxElements to see them`);
      if (includeText) out.push("", "Page text:", snap.text || "(empty)");
      return text(out.join("\n"));
    },
    { readOnlyHint: true },
  );

  tool(
    "screenshot",
    "Take a picture of the current tab: the viewport, the full page, or a single element. Brings the tab to the front if it's hidden (background tabs can't paint).",
    {
      fullPage: z.boolean().optional(),
      ...targetShape,
      format: z.enum(["png", "jpeg"]).optional().describe("Default png (viewport/element), jpeg for full page."),
    },
    async ({ fullPage, ref, selector, text: byText, format }) => {
      await pilot.ensureVisible(s);
      const fmt = format ?? (fullPage ? "jpeg" : "png");
      const params: Record<string, unknown> = { format: fmt, ...(fmt === "jpeg" ? { quality: 75 } : {}) };
      if (ref || selector || byText) {
        const box = await pilot.locate(s, { ref, selector, text: byText });
        params.clip = { x: box.pageX, y: box.pageY, width: Math.max(1, box.width), height: Math.max(1, box.height), scale: 1 };
        params.captureBeyondViewport = true;
      } else if (fullPage) {
        const m = await pilot.cdp(s, "Page.getLayoutMetrics");
        const size = m.cssContentSize ?? m.contentSize;
        params.clip = { x: 0, y: 0, width: Math.min(size.width, 8000), height: Math.min(size.height, 8000), scale: 1 };
        params.captureBeyondViewport = true;
      }
      const shot = await pilot.cdp(s, "Page.captureScreenshot", params, 45_000);
      return { content: [{ type: "image", data: shot.data, mimeType: `image/${fmt}` }] };
    },
    { readOnlyHint: true },
  );

  // ---------------------------------------------------------------- hands

  tool(
    "click",
    "Click an element (real mouse events, so hover states, focus and React handlers all fire). Target by ref, selector or text, or raw x/y viewport coordinates.",
    {
      ...targetShape,
      x: z.number().optional(),
      y: z.number().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
      double: z.boolean().optional(),
      modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).optional(),
    },
    async ({ ref, selector, text: byText, x, y, button, double, modifiers }) => {
      let px = x,
        py = y,
        note = "";
      if (px === undefined || py === undefined) {
        const box = await pilot.locate(s, { ref, selector, text: byText });
        px = box.x;
        py = box.y;
        if (box.covered) note = `\n⚠ Something else is on top of it (${box.covered}), so the click landed there. A real user would hit the same thing.`;
      }
      const mods = (modifiers ?? []).reduce((m, k) => m | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const)[k], 0);
      await pilot.mouse(s, px, py, { button, clickCount: double ? 2 : 1, modifiers: mods });
      await new Promise((r) => setTimeout(r, 150));
      return text(`Clicked ${ref ?? selector ?? (byText ? JSON.stringify(byText) : `(${Math.round(px)}, ${Math.round(py)})`)}.${note}`);
    },
  );

  tool(
    "hover",
    "Move the mouse over an element (menus, tooltips, hover styles).",
    targetShape,
    async (t) => {
      const box = await pilot.locate(s, t as Target);
      await pilot.mouse(s, box.x, box.y, { hoverOnly: true });
      return text(`Hovering ${t.ref ?? t.selector ?? JSON.stringify(t.text)}.`);
    },
  );

  tool(
    "type",
    "Type text. With a target it clicks into that field first; without one it types into whatever has focus. Works with React/Vue controlled inputs.",
    {
      ...targetShape,
      value: z.string().describe("The text to type."),
      clear: z.boolean().optional().describe("Replace what's already in the field. Default true when a target is given."),
      submit: z.boolean().optional().describe("Press Enter afterwards."),
    },
    async ({ ref, selector, text: byText, value, clear, submit }) => {
      const hasTarget = !!(ref || selector || byText);
      if (hasTarget) {
        const box = await pilot.locate(s, { ref, selector, text: byText });
        await pilot.mouse(s, box.x, box.y);
      }
      if (clear ?? hasTarget) {
        await pilot.evaluate(
          s,
          `(() => { const el = document.activeElement; if (!el) return; if (typeof el.select === 'function') el.select(); else if (el.isContentEditable) document.execCommand('selectAll'); })()`,
        );
        if (value === "") await pilot.press(s, "Backspace");
      }
      if (value) await pilot.cdp(s, "Input.insertText", { text: value });
      if (submit) await pilot.press(s, "Enter");
      return text(`Typed ${value.length} chars${submit ? " and hit Enter" : ""}.`);
    },
  );

  tool(
    "press",
    'Press a key or combo: "Enter", "Escape", "Tab", "ArrowDown", "Control+a", "Shift+Tab", "Meta+k".',
    { key: z.string(), times: z.number().int().min(1).max(50).optional() },
    async ({ key, times = 1 }) => {
      for (let i = 0; i < times; i++) await pilot.press(s, key);
      return text(`Pressed ${key}${times > 1 ? ` ×${times}` : ""}.`);
    },
  );

  tool(
    "select_option",
    "Pick an option in a native <select>, by value or visible label.",
    { ...targetShape, option: z.string() },
    async ({ ref, selector, text: byText, option }) => {
      await pilot.locate(s, { ref, selector, text: byText });
      const sel = ref ? `[data-tp-ref="${ref}"]` : selector;
      if (!sel) throw new Error("select_option needs a ref or selector.");
      const r = await pilot.evaluate<string>(
        s,
        `(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el || el.tagName !== 'SELECT') return 'That element is not a <select>. For custom dropdowns, click it open and click the option.';
          const want = ${JSON.stringify(option)};
          const opt = [...el.options].find(o => o.value === want) || [...el.options].find(o => o.label.trim() === want) || [...el.options].find(o => o.label.toLowerCase().includes(want.toLowerCase()));
          if (!opt) return 'No option matches. Options: ' + [...el.options].map(o => o.label.trim()).join(' | ');
          el.value = opt.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'Selected "' + opt.label.trim() + '".';
        })()`,
      );
      return text(r);
    },
  );

  tool(
    "scroll",
    "Scroll the page (or the scrollable area under an element) with real wheel events. Or scroll an element into view.",
    {
      ...targetShape,
      deltaY: z.number().optional().describe("Pixels down (negative = up). Default 600."),
      deltaX: z.number().optional(),
      intoView: z.boolean().optional().describe("Just scroll the target into view."),
    },
    async ({ ref, selector, text: byText, deltaY = 600, deltaX = 0, intoView }) => {
      const hasTarget = !!(ref || selector || byText);
      let x: number, y: number;
      if (hasTarget) {
        const box = await pilot.locate(s, { ref, selector, text: byText });
        if (intoView) return text("Scrolled it into view.");
        x = box.x;
        y = box.y;
      } else {
        const vp = await pilot.evaluate<{ w: number; h: number }>(s, "({w: innerWidth, h: innerHeight})");
        x = vp.w / 2;
        y = vp.h / 2;
      }
      await pilot.cdp(s, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
      await new Promise((r) => setTimeout(r, 200));
      const pos = await pilot.evaluate<{ y: number; max: number }>(s, "({y: Math.round(scrollY), max: document.documentElement.scrollHeight - innerHeight})");
      return text(`Scrolled. Page is at ${pos.y}/${Math.max(0, pos.max)}px.`);
    },
  );

  tool(
    "wait_for",
    "Wait until something shows up (or goes away): a CSS selector, or text on the page. Polls every 200ms.",
    {
      selector: z.string().optional(),
      text: z.string().optional(),
      gone: z.boolean().optional().describe("Wait for it to disappear instead."),
      timeoutMs: z.number().int().max(120_000).optional().describe("Default 10000."),
    },
    async ({ selector, text: want, gone, timeoutMs = 10_000 }) => {
      if (!selector && !want) throw new Error("Give me a selector or text to wait for.");
      const check = `(() => {
        ${selector ? `const el = document.querySelector(${JSON.stringify(selector)}); const a = !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);` : "const a = true;"}
        ${want ? `const b = (document.body?.innerText || '').includes(${JSON.stringify(want)});` : "const b = true;"}
        return a && b;
      })()`;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = await pilot.evaluate<boolean>(s, check).catch(() => false);
        if (found !== !!gone) return text(`${gone ? "Gone" : "Found it"} after ${Date.now() - start}ms.`);
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`Waited ${timeoutMs}ms; ${selector ?? JSON.stringify(want)} ${gone ? "is still there" : "never showed up"}.`);
    },
    { readOnlyHint: true },
  );

  tool(
    "viewport",
    "Emulate a screen size (responsive testing). Pass reset: true to go back to the real window.",
    {
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      mobile: z.boolean().optional().describe("Phone mode: touch events and meta-viewport handling. Pages without a viewport meta tag lay out at 980px wide, same as a real phone."),
      deviceScaleFactor: z.number().optional(),
      reset: z.boolean().optional(),
    },
    async ({ width, height, mobile = false, deviceScaleFactor = 0, reset }) => {
      if (reset) {
        await pilot.cdp(s, "Emulation.clearDeviceMetricsOverride");
        await pilot.cdp(s, "Emulation.setTouchEmulationEnabled", { enabled: false });
        return text("Viewport back to normal.");
      }
      if (!width || !height) throw new Error("Need width and height (or reset: true).");
      await pilot.cdp(s, "Emulation.setDeviceMetricsOverride", { width, height, mobile, deviceScaleFactor });
      await pilot.cdp(s, "Emulation.setTouchEmulationEnabled", { enabled: mobile });
      return text(`Viewport is now ${width}×${height}${mobile ? " (mobile)" : ""}.`);
    },
  );

  // ---------------------------------------------------------------- black box

  tool(
    "console",
    "Read the tab's console: logs, warnings, errors, uncaught exceptions, browser-level messages (CSP, CORS...), navigations and dialogs. Use `since` to get only what's new.",
    {
      level: z.enum(["all", "error", "warn", "info", "log", "debug"]).optional().describe("'error' = errors only, 'warn' = warnings and errors. Default all."),
      since: z.number().int().optional().describe("Only entries after this seq number (from a previous call)."),
      search: z.string().optional().describe("Only entries containing this text."),
      limit: z.number().int().optional().describe("Max entries, newest kept. Default 100."),
      clear: z.boolean().optional().describe("Empty the buffer after reading."),
    },
    async ({ level = "all", since, search, limit = 100, clear }) => {
      const r = bridge.recorder(pilot.tab(s));
      const rank: Record<string, number> = { error: 4, warn: 3, info: 2, log: 2, debug: 1 };
      let rows = r.console.filter((e) => since === undefined || e.seq > since);
      if (level === "error") rows = rows.filter((e) => e.level === "error");
      else if (level === "warn") rows = rows.filter((e) => (rank[e.level] ?? 0) >= 3);
      else if (level !== "all") rows = rows.filter((e) => e.level === level || !(e.level in rank));
      if (search) rows = rows.filter((e) => e.text.toLowerCase().includes(search.toLowerCase()));
      const dropped = Math.max(0, rows.length - limit);
      rows = rows.slice(-limit);
      const last = r.console.at(-1)?.seq ?? since ?? 0;
      if (clear) r.console.length = 0;
      if (!rows.length) return text(`Console is quiet${since !== undefined ? ` since #${since}` : ""}. (latest seq ${last})`);
      const lines = rows.map((e) => `#${e.seq} ${fmtTime(e.ts)} ${e.level.toUpperCase().padEnd(5)} ${clip(e.text, 2000)}${e.source ? `  (${e.source})` : ""}`);
      if (dropped) lines.unshift(`… ${dropped} older entries not shown`);
      lines.push(`\nlatest seq ${last}; pass since: ${last} next time to get only new entries`);
      return text(lines.join("\n"));
    },
    { readOnlyHint: true },
  );

  tool(
    "network",
    "List the tab's network requests: method, status, type, size, timing. Filter to find the broken ones. Use network_detail for headers and bodies.",
    {
      filter: z.string().optional().describe("Substring of the URL."),
      type: z.string().optional().describe("Resource type: XHR, Fetch, Document, Script, Stylesheet, Image, WebSocket..."),
      failed: z.boolean().optional().describe("Only failed requests and 4xx/5xx responses."),
      since: z.number().int().optional().describe("Only requests after this seq number."),
      limit: z.number().int().optional().describe("Max rows, newest kept. Default 60."),
      clear: z.boolean().optional(),
    },
    async ({ filter, type, failed, since, limit = 60, clear }) => {
      const r = bridge.recorder(pilot.tab(s));
      let rows = [...r.network.values()].sort((a, b) => a.seq - b.seq);
      if (since !== undefined) rows = rows.filter((e) => e.seq > since);
      if (filter) rows = rows.filter((e) => e.url.includes(filter));
      if (type) rows = rows.filter((e) => e.type?.toLowerCase() === type.toLowerCase());
      if (failed) rows = rows.filter((e) => e.failed || (e.status ?? 0) >= 400);
      const dropped = Math.max(0, rows.length - limit);
      rows = rows.slice(-limit);
      if (clear) r.network.clear();
      if (!rows.length) return text("No matching requests recorded.");
      const lines = rows.map(networkLine);
      if (dropped) lines.unshift(`… ${dropped} older requests not shown`);
      return text(lines.join("\n"));
    },
    { readOnlyHint: true },
  );

  tool(
    "network_detail",
    "Everything about one request: headers both ways, request payload, and the response body (text bodies, truncated).",
    {
      seq: z.number().int().describe("The #number from the network tool."),
      maxBody: z.number().int().optional().describe("Max chars of response body. Default 20000."),
    },
    async ({ seq, maxBody = 20_000 }) => {
      const r = bridge.recorder(pilot.tab(s));
      const e = [...r.network.values()].find((x) => x.seq === seq);
      if (!e) throw new Error(`No request #${seq} in the buffer.`);
      const hdrs = (h?: Record<string, string>) => (h ? Object.entries(h).map(([k, v]) => `  ${k}: ${v}`).join("\n") : "  (none recorded)");
      const out = [networkLine(e), "", "Request headers:", hdrs(e.requestHeaders)];
      let post = e.postData;
      if (!post && e.hasPostData) post = (await pilot.cdp(s, "Network.getRequestPostData", { requestId: e.requestId }).catch(() => null))?.postData;
      if (post) out.push("", "Request body:", clip(post, maxBody));
      out.push("", `Response: ${e.status ?? "-"} ${e.statusText ?? ""}`, "Response headers:", hdrs(e.responseHeaders));
      if (e.done && !e.failed) {
        try {
          const b = await pilot.cdp(s, "Network.getResponseBody", { requestId: e.requestId });
          const textLike = /json|text|javascript|xml|html|css|svg|x-www-form/.test(e.mimeType ?? "");
          if (b.base64Encoded && !textLike) out.push("", `Response body: ${e.mimeType} binary, ${fmtBytes(Buffer.from(b.body, "base64").length)}`);
          else out.push("", "Response body:", clip(b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body, maxBody));
        } catch {
          out.push("", "Response body: not available (evicted, or the page navigated away).");
        }
      }
      return text(out.join("\n"));
    },
    { readOnlyHint: true },
  );

  // ---------------------------------------------------------------- power tools

  tool(
    "evaluate",
    "Run JavaScript in the page and get the result back (JSON-serialized). Promises are awaited. Great for reading app state, localStorage, or poking at things.",
    { expression: z.string().describe("A JS expression, e.g. `localStorage.getItem('token')` or `(async () => { ... })()`.") },
    async ({ expression }) => {
      const v = await pilot.evaluate(s, expression);
      return text(v === undefined ? "undefined" : clip(typeof v === "string" ? v : JSON.stringify(v, null, 2), 30_000));
    },
  );

  tool(
    "cdp",
    "Raw Chrome DevTools Protocol command on the current tab, for anything the other tools don't cover (performance metrics, cookies, CSS coverage, geolocation, throttling...). See https://chromedevtools.github.io/devtools-protocol/",
    {
      method: z.string().describe("e.g. 'Performance.getMetrics', 'Network.emulateNetworkConditions', 'Storage.clearDataForOrigin'"),
      params: z.record(z.string(), z.any()).optional(),
    },
    async ({ method, params }) => {
      const r = await pilot.cdp(s, method, params ?? {});
      return text(clip(JSON.stringify(r, null, 2), 30_000));
    },
  );

  return server;
}
