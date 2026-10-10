/**
 * Drive the calendar in a real browser: drag it, draw on it, resize it.
 *
 *   node scripts/verify-calendar-browser.mjs [baseUrl] [--port 9222]
 *
 * WHY THIS EXISTS
 *
 * `verify:calendar` drives the geometry and the gesture engine directly, which
 * is where the arithmetic and the state machine live. It cannot tell you that
 * the grid a person sees is wired to that engine: that a `pointerdown` reaches
 * `onBlockPointerDown`, that the ghost follows the pointer, that the block moves
 * to the column it was dropped on, or that the server ended up with the time
 * that was on the label. Those are the failures that look like the feature not
 * working at all, and only a browser can see them.
 *
 * WHAT IT DOES
 *
 *   1. opens the app and My cave → Calendar;
 *   2. adds an entry through the room's own quick-add line;
 *   3. **drags a block** across days and hours with real `Input.dispatchMouseEvent`
 *      input, and checks both the DOM and the database;
 *   4. **drags on empty grid** to draw a new entry, types a name, presses Enter;
 *   5. **drags a block's bottom edge** to resize it;
 *   6. **drags a month chip** to another day and checks the day moved while the
 *      clock did not;
 *   7. screenshots each step into `data/shots/`, and reports every console error;
 *   8. removes everything it created, and purges it from the bin.
 *
 * It refuses to run against a database it cannot clean up, and it names every
 * marker it creates so a leftover row is obvious rather than mysterious.
 *
 * THE ENVIRONMENT IT NEEDS
 *
 * A Chromium that can start. In a locked-down sandbox the browser's own
 * multi-process transport (Mojo, over named pipes) is denied and it dies before
 * `/json/version` answers — this script says so in one line and exits 0 rather
 * than pretending. A browser started outside that confinement can be attached to
 * with `--port`, which is how this was run.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const base = (process.argv[2] ?? `http://127.0.0.1:${process.env.PORT ?? "4310"}`).replace(/\/$/, "");
const portFlag = process.argv.indexOf("--port");
const debugPort = Number(portFlag === -1 ? (process.env.XANA_CDP_PORT ?? "9222") : process.argv[portFlag + 1]);
const OUT_DIR = join(process.cwd(), "data", "shots");

/**
 * The app's time zone, read out of the app rather than restated here.
 *
 * This script has to turn a stored instant back into the clock a person reads,
 * and the one thing it must not do is decide for itself which zone that is —
 * that is the whole point of `@/lib/core/zone`, and a test that hardcoded
 * "+08:00" would keep passing after the app moved. So the constant is read from
 * the file that owns it.
 */
const APP_ZONE =
  /APP_TIME_ZONE\s*=\s*"([^"]+)"/.exec(readFileSync(join(process.cwd(), "src/lib/core/zone.ts"), "utf8"))?.[1] ??
  "UTC";
const clockFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "13:45" for a stored instant, in the app's zone. */
function hourMinute(iso) {
  return clockFormat.format(new Date(iso));
}

const dayParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The `YYYY-MM-DD` a stored instant falls on, in the app's zone.
 *
 * Three checks used to ask `event.start.startsWith(dayKey)`, which compares the
 * **UTC** date against a day key that is in the app's zone. Those are the same
 * thing for most of the day and different for the first hours of it: an entry
 * dropped on the 4th at 06:00 is stored `2026-10-03T22:00:00.000Z`, so the
 * check reported the wrong day while printing the right answer next to it —
 * `2026-10-03T22:00:00.000Z vs 2026-10-04`.
 *
 * It passed until it was run just after midnight, because the slot the suite
 * picks depends on where the grid is scrolled, and that depends on the time. A
 * comparison between an instant and a calendar day has to happen in one zone,
 * and the day keys come from the app, so the instant is converted here rather
 * than restated.
 */
function dayOf(iso) {
  if (!iso) return "(no entry)";
  const parts = dayParts.formatToParts(new Date(iso));
  const value = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** A `YYYY-MM-DD` key moved by whole days, for the cleanup sweep. */
function shiftDay(key, days) {
  const [year, month, day] = String(key || "2026-01-01").split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return moved.toISOString().slice(0, 10);
}

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${"─".repeat(64)}\n${title}\n${"─".repeat(64)}`);
}

/* ------------------------------------------------------------------ */
/* A very small CDP client                                             */
/* ------------------------------------------------------------------ */

class Devtools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.sessionId = undefined;
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 20_000);
    });
  }

  once(method, timeoutMs = 15_000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        resolve(null);
      }, timeoutMs);
      const listener = (message) => {
        if (message.method !== method) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message.params);
      };
      this.listeners.add(listener);
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "evaluate threw");
    }
    return result.result.value;
  }

  async shot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${name}.png`), Buffer.from(data, "base64"));
  }

  /** One mouse event. `type` is mousePressed, mouseMoved or mouseReleased. */
  mouse(type, x, y, extra = {}) {
    return this.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: type === "mouseMoved" ? 0 : 1,
      pointerType: "mouse",
      ...extra,
    });
  }

  /**
   * One touch event. `type` is touchStart, touchMove, touchEnd or touchCancel.
   *
   * A real touch, not a synthesized chain of pointer events: the hold window,
   * the scroll hand-off and `touch-action` are the browser's own behaviour, and
   * a test that dispatched `pointerdown` itself would be testing the test.
   */
  touch(type, points) {
    return this.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((point, index) => ({
        x: point.x,
        y: point.y,
        id: point.id ?? index + 1,
        radiusX: 12,
        radiusY: 12,
        force: 1,
      })),
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* The app, from outside                                               */
/* ------------------------------------------------------------------ */

async function api(op, input = {}) {
  const response = await fetch(`${base}/api/cave`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op, ...input }),
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    /* a route that answers nothing is reported by the caller */
  }
  return { status: response.status, body };
}

/** Every event in a window, oldest first. */
async function range(from, to) {
  const answer = await api("event.range", { from, to });
  return answer.body?.range?.events ?? [];
}

/**
 * Wait for the stored clock of one entry to become `want`, and say how long it
 * took since `since`.
 *
 * A drop is optimistic: the grid moves on the frame the finger lifts and the
 * server is asked afterwards, so a single read taken a fixed moment later is a
 * race, and this check read the pre-drop clock once and called it a
 * disagreement. The round trip is normally far shorter than the fixed sleeps the
 * rest of this suite uses, so the wait is bounded and the number it reports is
 * the real latency rather than a guess.
 */
async function settledStart(id, day, want, since, timeoutMs = 4000) {
  let clock = null;
  for (;;) {
    const row = (await range(day, day)).find((event) => event.id === id);
    clock = row ? hourMinute(row.start) : null;
    if (clock === want || Date.now() - since > timeoutMs) break;
    await sleep(120);
  }
  return { clock, waited: Date.now() - since };
}

async function main() {
  section("Is there a browser to drive?");

  let info = null;
  try {
    info = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
  } catch (err) {
    console.log(`  note  no DevTools endpoint on 127.0.0.1:${debugPort} — ${err.message}`);
    console.log("");
    console.log("  A browser has to be started outside this process, e.g.:");
    console.log('    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --headless=new \\');
    console.log(`      --remote-debugging-port=${debugPort} --user-data-dir=%TEMP%\\xana-cdp --no-first-run \\`);
    console.log("      --disable-extensions --disable-crash-reporter about:blank");
    console.log("");
    console.log("  Chromium cannot start *inside* the DSH sandbox: its browser process needs a named");
    console.log("  pipe for its own children and the sandbox denies one, so it dies before the");
    console.log("  endpoint answers. Nothing here is broken; there is just no browser.");
    console.log("");
    console.log("  Skipped: 0 checks run.\n");
    return 0;
  }

  console.log(`  browser   ${info.Browser}`);
  console.log(`  protocol  ${info["Protocol-Version"]}`);

  const socket = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("could not open the DevTools socket")), { once: true });
  });
  const cdp = new Devtools(socket);
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  cdp.sessionId = attached.sessionId;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");

  const consoleErrors = [];
  const resourceErrors = [];

  /**
   * Noise from the browser's own profile, not from the app.
   *
   * A missing icon is the browser asking for something the app never promised.
   * `Cannot redefine property: ethereum` is a wallet extension injecting into
   * every page it can reach, and `Unchecked runtime.lastError` is an extension's
   * own message port closing — both appear in a profile with extensions in it and
   * in no clean one. `--disable-extensions` on the launch avoids them entirely;
   * they are filtered here as well so a run against a normal profile still
   * reports on the app rather than on somebody's password manager.
   */
  const isProfileNoise = (text) =>
    /favicon|apple-touch-icon/i.test(text) ||
    /redefine property: ethereum/i.test(text) ||
    /Unchecked runtime\.lastError/i.test(text);

  cdp.listeners.add((message) => {
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      const text = details?.exception?.description ?? details?.text ?? "exception";
      if (isProfileNoise(text)) resourceErrors.push(text);
      else consoleErrors.push(text);
    }
    if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
      const entry = message.params.entry;
      const where = `${entry.text} ${entry.url ?? ""}`.trim();
      if (isProfileNoise(where)) resourceErrors.push(where);
      else consoleErrors.push(where);
    }
  });

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const marker = `cal-probe-${Date.now().toString(36)}`;
  const created = [];
  /** Declared out here because the cleanup at the foot needs them. */
  let windowFrom = "";
  let windowTo = "";
  let targetDay = "";

  try {
    /* ---------------- open the room ---------------- */

    section("Opening My cave → Calendar");

    const loaded = cdp.once("Page.loadEventFired", 20_000);
    await cdp.send("Page.navigate", { url: base });
    await loaded;
    await sleep(600);

    const shell = await cdp.eval("({ text: document.body.innerText.length, title: document.title })");
    check("the app shell rendered", shell.text > 40, JSON.stringify(shell));

    // A real click on the header button, through the same path a person takes.
    const openedCave = await cdp.eval(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => /my cave/i.test(node.textContent || '') || /my cave/i.test(node.getAttribute('aria-label') || ''));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    check("the My cave button was found and pressed", openedCave === true);
    await sleep(400);

    const openedRoom = await cdp.eval(`(() => {
      const tab = [...document.querySelectorAll('[role="tab"], button')].find((node) => (node.textContent || '').trim() === 'Calendar');
      if (!tab) return false;
      tab.click();
      return true;
    })()`);
    check("the Calendar room was found and selected", openedRoom === true);
    await sleep(700);

    const grid = await cdp.eval(`(() => {
      const room = document.querySelector('[data-calendar]');
      if (!room) return null;
      return {
        view: room.dataset.view,
        window: room.dataset.window,
        columns: document.querySelectorAll('[data-column]').length,
        scroller: Boolean(document.querySelector('[data-time-scroll]')),
        quickAdd: Boolean(document.querySelector('[data-quick-add]')),
      };
    })()`);
    check("the calendar room rendered", grid !== null, JSON.stringify(grid));
    check("it opened on the week", grid?.view === "week", grid?.view);
    check("with seven day columns", grid?.columns === 7, String(grid?.columns));
    check("a scrolling grid and a quick-add line", grid?.scroller === true && grid?.quickAdd === true, JSON.stringify(grid));
    await cdp.shot("calendar-week");

    const [from, to] = String(grid?.window ?? "..").split("..");
    windowFrom = from ?? "";
    windowTo = to ?? "";
    check("and it asked the server for a window of days", /^\d{4}-\d{2}-\d{2}$/.test(windowFrom), String(grid?.window));

    /* ---------------- add through the line ---------------- */

    section("Adding an entry through the room's own line");

    // The day the grid is showing, so the new entry is visible without paging.
    targetDay = windowFrom;
    const quick = await cdp.eval(`(() => {
      const field = document.querySelector('[data-quick-add]');
      if (!field) return null;
      const box = field.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    check("the quick-add field is on screen", quick !== null, JSON.stringify(quick));

    await cdp.mouse("mousePressed", quick.x, quick.y);
    await cdp.mouse("mouseReleased", quick.x, quick.y);
    await cdp.send("Input.insertText", { text: `${marker} standup` });
    await sleep(120);
    const typed = await cdp.eval("document.querySelector('[data-quick-add]')?.value ?? ''");
    check("the title was typed into it", typed.includes(marker), typed);

    /**
     * Wait for the button to be ready rather than for a fixed number of
     * milliseconds.
     *
     * `Add` is disabled until React has the text in its own state, and a click
     * dispatched at a disabled button does nothing at all — which reads as "the
     * calendar cannot add anything" when it is really "the test typed faster than
     * the page rendered". This was a real false failure here.
     */
    let addReady = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      addReady = await cdp.eval(`(() => {
        const field = document.querySelector('[data-quick-add]');
        const buttons = [...document.querySelectorAll('button')].filter((node) => node.textContent.trim() === 'Add');
        return {
          value: field?.value ?? '',
          buttons: buttons.length,
          enabled: buttons.filter((node) => !node.disabled).length,
          slot: document.querySelector('[data-quick-slot]')?.textContent?.trim() ?? '',
        };
      })()`);
      if (addReady.enabled > 0) break;
      await sleep(50);
    }
    check("the Add button became ready once the field had text", addReady?.enabled === 1, JSON.stringify(addReady));

    const added = await cdp.eval(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Add' && !node.disabled);
      if (!button) return false;
      button.click();
      return true;
    })()`);
    check("the Add button was pressed", added === true);
    await sleep(900);

    const afterAdd = await range(targetDay, windowTo);
    const addedEvent = afterAdd.find((event) => event.title.includes(marker));
    check("the entry reached the database", Boolean(addedEvent), JSON.stringify(afterAdd.map((e) => e.title)));
    if (addedEvent) created.push(addedEvent.id);

    const blockBox = await cdp.eval(`(() => {
      const node = document.querySelector('[data-event="${addedEvent?.id}"]');
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        x: box.left + box.width / 2,
        y: box.top + Math.min(box.height / 2, 14),
        start: node.dataset.start,
        minutes: node.dataset.minutes,
        day: node.closest('[data-column]')?.dataset.column,
      };
    })()`);
    check("and it is drawn on the grid", blockBox !== null, JSON.stringify(blockBox));
    check("with the time it was given", /^\d{2}:\d{2}$/.test(blockBox?.start ?? ""), String(blockBox?.start));
    if (blockBox === null) throw new Error("no block was drawn, so the drag sections cannot run");

    /* ---------------- drag the block ---------------- */

    section("Dragging a block to another hour and another day");

    /**
     * The target is read from where the grid is *scrolled to*, not from the top
     * of the column's own box.
     *
     * A time grid opens scrolled to the current hour, so a column's
     * `getBoundingClientRect().top` is above the viewport by whatever has been
     * scrolled past — and a drag dispatched at a negative y is a drag the browser
     * clamps, which is a test failure that looks exactly like a broken feature.
     * The point is taken from the scroller's own visible box instead.
     */
    const target = await cdp.eval(`(() => {
      const scroller = document.querySelector('[data-time-scroll]');
      const columns = [...document.querySelectorAll('[data-column]')];
      const last = columns[columns.length - 1];
      const box = scroller.getBoundingClientRect();
      const column = last.getBoundingClientRect();
      return {
        day: last.dataset.column,
        x: column.left + column.width / 2,
        y: Math.round(box.top + box.height * 0.62),
        hour: Number.parseFloat(getComputedStyle(last).getPropertyValue('--cal-hour') || '56'),
      };
    })()`);
    check("a target column was measured inside the viewport", Boolean(target?.day) && target.y > 0, JSON.stringify(target));

    // A frame counter, so "smooth" is measured rather than asserted. It is
    // informational — a headless browser paints on its own schedule — but a
    // drag that stalls the main thread shows up here as one huge gap.
    await cdp.eval(`(() => {
      const box = { frames: 0, gaps: [], last: performance.now(), raf: 0 };
      window.__calFrames = box;
      const tick = (now) => {
        box.gaps.push(now - box.last);
        box.last = now;
        box.frames += 1;
        box.raf = requestAnimationFrame(tick);
      };
      box.raf = requestAnimationFrame(tick);
    })()`);

    await cdp.mouse("mousePressed", blockBox.x, blockBox.y);
    const steps = 12;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      await cdp.mouse(
        "mouseMoved",
        blockBox.x + (target.x - blockBox.x) * t,
        blockBox.y + (target.y - blockBox.y) * t,
      );
      await sleep(16);
    }

    const midDrag = await cdp.eval(`(() => {
      const ghost = document.querySelector('[data-drag-ghost]');
      const indicator = document.querySelector('[data-drop-indicator]');
      return {
        ghost: Boolean(ghost),
        label: ghost?.textContent?.trim() ?? '',
        transform: ghost ? getComputedStyle(ghost).transform : '',
        indicatorShown: indicator ? getComputedStyle(indicator).opacity : '0',
        willLandOn: indicator?.dataset.day ?? '',
        willBe: indicator?.dataset.range ?? '',
      };
    })()`);
    check("a copy of the block follows the pointer", midDrag.ghost === true, JSON.stringify(midDrag));
    check("and it carries the range it will land on", /\d/.test(midDrag.label), midDrag.label);
    check("the copy is actually moving", /matrix|translate/.test(midDrag.transform), midDrag.transform);
    check("and a drop slot is drawn under it", Number(midDrag.indicatorShown) > 0.5, midDrag.indicatorShown);
    check("the slot names the day it is over", midDrag.willLandOn === target.day, `${midDrag.willLandOn} vs ${target.day}`);
    await cdp.shot("calendar-dragging");

    await cdp.mouse("mouseReleased", target.x, target.y);
    await sleep(900);

    const frames = await cdp.eval(`(() => {
      const box = window.__calFrames;
      cancelAnimationFrame(box.raf);
      const gaps = box.gaps.slice(2).sort((a, b) => a - b);
      return { frames: box.frames, median: Math.round(gaps[Math.floor(gaps.length / 2)] ?? 0), worst: Math.round(gaps[gaps.length - 1] ?? 0) };
    })()`);
    console.log(`  info  ${frames.frames} frames during the drag, median gap ${frames.median}ms, worst ${frames.worst}ms`);
    check("the page kept painting while the block was dragged", frames.frames >= 10, JSON.stringify(frames));

    const afterDrag = (await range(targetDay, windowTo)).find((event) => event.id === addedEvent?.id);
    const expectedStart = String(midDrag.willBe).split("–")[0];
    check("the entry is now on the day the slot named", dayOf(afterDrag?.start) === midDrag.willLandOn, `${dayOf(afterDrag?.start)} vs ${midDrag.willLandOn} (stored ${afterDrag?.start})`);
    check(
      "at the minute the label said",
      afterDrag !== undefined && hourMinute(afterDrag.start) === expectedStart,
      `${afterDrag ? hourMinute(afterDrag.start) : "missing"} vs ${expectedStart}`,
    );

    const drawnAfter = await cdp.eval(`(() => {
      const node = document.querySelector('[data-event="${addedEvent?.id}"]');
      return node
        ? { day: node.closest('[data-column]')?.dataset.column, start: node.dataset.start }
        : null;
    })()`);
    check("and the grid agrees with the database", drawnAfter?.day === midDrag.willLandOn && drawnAfter?.start === expectedStart, JSON.stringify(drawnAfter));
    await cdp.shot("calendar-dropped");

    /* ---------------- draw a new entry ---------------- */

    section("Drawing a new entry on empty grid");

    const slot = await cdp.eval(`(() => {
      const scroller = document.querySelector('[data-time-scroll]');
      const columns = [...document.querySelectorAll('[data-column]')];
      const first = columns[0];
      const column = first.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      const hour = Number.parseFloat(getComputedStyle(first).getPropertyValue('--cal-hour') || '56');
      // Two points in the visible half of the grid, three hours apart — the
      // drawn block's height is what tells us the drag was read as a duration
      // rather than as a click.
      const top = Math.round(box.top + box.height * 0.45);
      return {
        day: first.dataset.column,
        x: column.left + column.width / 2,
        top,
        bottom: Math.round(top + hour),
        hour,
      };
    })()`);

    await cdp.mouse("mousePressed", slot.x, slot.top);
    for (let step = 1; step <= 8; step++) {
      const t = step / 8;
      await cdp.mouse("mouseMoved", slot.x, slot.top + (slot.bottom - slot.top) * t);
      await sleep(16);
    }
    const slotPreview = await cdp.eval(`document.querySelector('[data-drop-indicator]')?.dataset.range ?? ''`);
    await cdp.mouse("mouseReleased", slot.x, slot.bottom);
    await sleep(400);

    const editor = await cdp.eval(`(() => {
      const node = document.querySelector('[data-event-editor]');
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { left: Math.round(box.left), top: Math.round(box.top), label: node.getAttribute('aria-label'), summary: node.querySelector('[data-editor-summary]')?.textContent ?? '' };
    })()`);
    check("the editor opened where the slot was drawn", editor !== null, JSON.stringify(editor));
    check("it says it is a new event", editor?.label === "New event", String(editor?.label));
    check("and it is on screen", (editor?.left ?? -1) >= 0 && (editor?.top ?? -1) >= 0, JSON.stringify(editor));
    await cdp.shot("calendar-new");

    /**
     * Wait for the caret to be in the title field before typing into it.
     *
     * The editor focuses its first field from an effect, which runs after the
     * frame that drew it — and text sent before that lands on `body` and is
     * simply lost. That is a real race: the run before this one typed into
     * nothing, the entry was never written, and the failure read as "the
     * calendar cannot create an event".
     */
    let caret = false;
    for (let attempt = 0; attempt < 24 && !caret; attempt++) {
      caret = await cdp.eval(`document.activeElement?.getAttribute('aria-label') === 'Event title'`);
      if (!caret) await sleep(50);
    }
    check("the editor put the caret in the title", caret === true);

    await cdp.send("Input.insertText", { text: `${marker} drawn` });
    let typedDrawn = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      typedDrawn = await cdp.eval(`document.querySelector('[data-event-editor] input[aria-label="Event title"]')?.value ?? ''`);
      if (typedDrawn.includes(marker)) break;
      await sleep(50);
    }
    check("the title was typed into the editor", typedDrawn.includes(marker), typedDrawn);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      // `text` is what makes this a character, and Chromium runs implicit form
      // submission down the character path: without it the key arrives as a raw
      // code event, React sees it, and nothing submits.
      text: "\r",
      unmodifiedText: "\r",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await sleep(900);

    const drawn = (await range(targetDay, windowTo)).find((event) => event.title.includes("drawn"));
    check("the drawn entry reached the database", Boolean(drawn), marker);
    if (drawn) created.push(drawn.id);
    check("on the day the drag started", dayOf(drawn?.start) === slot.day, `${dayOf(drawn?.start)} vs ${slot.day} (stored ${drawn?.start})`);
    check(
      "at the start of the block that was drawn",
      drawn !== undefined && hourMinute(drawn.start) === String(slotPreview).split("–")[0],
      `${drawn ? hourMinute(drawn.start) : "missing"} vs ${slotPreview}`,
    );
    const closed = await cdp.eval(`(() => {
      const editor = document.querySelector('[data-event-editor]');
      return { open: Boolean(editor), error: editor?.querySelector('[role="alert"]')?.textContent ?? '' };
    })()`);
    check("and the editor closed behind it", closed.open === false, JSON.stringify(closed));

    /* ---------------- resize ---------------- */

    section("Resizing a block by its edge");

    const grip = await cdp.eval(`(() => {
      const node = document.querySelector('[data-event="${drawn?.id}"]');
      const handle = node?.querySelector('[data-edge="end"]');
      if (!node || !handle) return null;
      const box = handle.getBoundingClientRect();
      const hour = Number.parseFloat(getComputedStyle(node).getPropertyValue('--cal-hour') || '56');
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, minutes: Number(node.dataset.minutes), hour, day: node.dataset.day };
    })()`);
    check("the block has a bottom edge to grab", grip !== null, JSON.stringify(grip));

    if (grip) {
      await cdp.mouse("mousePressed", grip.x, grip.y);
      for (let step = 1; step <= 8; step++) {
        await cdp.mouse("mouseMoved", grip.x, grip.y + (grip.hour * step) / 8);
        await sleep(16);
      }
      await cdp.mouse("mouseReleased", grip.x, grip.y + grip.hour);
      await sleep(900);

      const resized = (await range(targetDay, windowTo)).find((event) => event.id === drawn?.id);
      const minutes =
        resized === undefined
          ? 0
          : Math.round((Date.parse(resized.end) - Date.parse(resized.start)) / 60_000);
      check("the length grew by the hour it was dragged", minutes === grip.minutes + 60, `${minutes} vs ${grip.minutes}`);
    }

    /* ---------------- the month ---------------- */

    section("The month view, and a chip dragged to another day");

    const toMonth = await cdp.eval(`(() => {
      const chip = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Month');
      if (!chip) return false;
      chip.click();
      return true;
    })()`);
    check("the Month view was selected", toMonth === true);
    await sleep(900);

    const month = await cdp.eval(`(() => {
      const cells = [...document.querySelectorAll('[data-day]')];
      const anchor = document.querySelector('[data-calendar]')?.dataset.anchor ?? '';
      return {
        count: cells.length,
        first: cells[0]?.dataset.day,
        last: cells[cells.length - 1]?.dataset.day,
        anchor,
        holdsAnchor: cells.some((cell) => cell.dataset.day === anchor),
      };
    })()`);
    check("42 day cells were drawn", month.count === 42, String(month.count));
    check("and the anchor's own day is one of them", month.holdsAnchor === true, JSON.stringify(month));
    // The month grid reaches six weeks past the week the drag test used, so the
    // reads after this have to cover the whole grid rather than the old window.
    const monthFrom = String(month.first);
    const monthTo = String(month.last);
    await cdp.shot("calendar-month");

    const chipDrag = await cdp.eval(`(() => {
      const chip = document.querySelector('[data-event="${addedEvent?.id}"]');
      const cells = [...document.querySelectorAll('[data-day]')];
      if (!chip || cells.length < 10) return null;
      const from = chip.getBoundingClientRect();
      const home = chip.closest('[data-day]')?.dataset.day;
      const away = cells.find((cell) => cell.dataset.day > (home ?? ''));
      if (!away) return null;
      const to = away.getBoundingClientRect();
      return {
        home,
        target: away.dataset.day,
        from: { x: from.left + from.width / 2, y: from.top + from.height / 2 },
        to: { x: to.left + to.width / 2, y: to.top + to.height / 2 },
      };
    })()`);
    check("a chip and a target day were found", chipDrag !== null, JSON.stringify(chipDrag));

    const before = (await range(monthFrom, monthTo)).find((event) => event.id === addedEvent?.id);

    if (chipDrag) {
      await cdp.mouse("mousePressed", chipDrag.from.x, chipDrag.from.y);
      for (let step = 1; step <= 10; step++) {
        const t = step / 10;
        await cdp.mouse(
          "mouseMoved",
          chipDrag.from.x + (chipDrag.to.x - chipDrag.from.x) * t,
          chipDrag.from.y + (chipDrag.to.y - chipDrag.from.y) * t,
        );
        await sleep(16);
      }
      const highlighted = await cdp.eval(`(() => {
        const marked = document.querySelector('[data-drop="true"]');
        return { count: document.querySelectorAll('[data-drop="true"]').length, day: marked?.dataset.day ?? '' };
      })()`);
      check("the day under the chip is highlighted", highlighted.count === 1, JSON.stringify(highlighted));
      check("and it is the day the pointer is over", highlighted.day === chipDrag.target, `${highlighted.day} vs ${chipDrag.target}`);
      await cdp.shot("calendar-chip-dragging");
      await cdp.mouse("mouseReleased", chipDrag.to.x, chipDrag.to.y);
      await sleep(900);

      const moved = (await range(monthFrom, monthTo)).find((event) => event.id === addedEvent?.id);
      check("the chip's day moved", dayOf(moved?.start) === chipDrag.target, `${dayOf(moved?.start)} vs ${chipDrag.target} (stored ${moved?.start})`);
      check(
        "and its clock did not",
        moved !== undefined &&
          before !== undefined &&
          hourMinute(moved.start) === hourMinute(before.start) &&
          hourMinute(moved.end) === hourMinute(before.end),
        `${moved ? hourMinute(moved.start) : "missing"} vs ${before ? hourMinute(before.start) : "missing"}`,
      );
    }

    /* ---------------- the event board ---------------- */

    section("The event board: reachable, and removable");

    // The section above left the room in the month, which has no hour columns
    // to press. Back to the week, where "empty grid" is a real thing.
    await cdp.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Week')?.click()`);
    await sleep(800);

    /**
     * Everything below is a real press through the browser, not a synthetic
     * `click()`: the bug this covers was a control that existed, was in the DOM,
     * and could not be pressed, and `node.click()` would have called it happily
     * from off screen. A target is reachable when `elementFromPoint` at its own
     * centre returns it, which is the same question a finger asks.
     */
    const board = () =>
      cdp.eval(`(() => {
        const card = document.querySelector('[data-event-editor]');
        if (!card) return null;
        const box = card.getBoundingClientRect();
        const at = (node) => {
          const r = node.getBoundingClientRect();
          const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
          const hit = document.elementFromPoint(x, y);
          return {
            text: (node.textContent || '').trim().slice(0, 10),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            inView: r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
            hittable: Boolean(hit) && (hit === node || node.contains(hit)),
          };
        };
        return {
          rect: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
          bottom: Math.round(box.bottom),
          viewport: [innerWidth, innerHeight],
          scrolls: card.scrollHeight > card.clientHeight + 1,
          controls: [...card.querySelectorAll('button')].map(at),
        };
      })()`);

    const openedBoard = await cdp.eval(`(() => {
      const column = document.querySelector('[data-column]');
      if (!column) return null;
      const box = column.getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      for (let y = Math.round(box.top + 30); y < Math.round(box.bottom) - 30; y += 6) {
        if (document.elementFromPoint(x, y) === column) return { x, y };
      }
      return null;
    })()`);
    check("an empty patch of grid to press", openedBoard !== null, JSON.stringify(openedBoard));

    if (openedBoard) {
      await cdp.mouse("mousePressed", openedBoard.x, openedBoard.y);
      await cdp.mouse("mouseReleased", openedBoard.x, openedBoard.y);
      await sleep(700);
    }
    const wide = await board();
    check("pressing empty grid opens the board", wide !== null, JSON.stringify(wide));
    check(
      "every control in it is inside the window and can be pressed",
      wide !== null && wide.controls.every((control) => control.inView && control.hittable),
      JSON.stringify(wide?.controls?.filter((control) => !control.inView || !control.hittable)),
    );
    check(
      "and it does not need to scroll to reach them",
      wide !== null && wide.scrolls === false,
      `card ${wide?.rect?.[3]}px in a ${wide?.viewport?.[1]}px window, scrolls ${wide?.scrolls}`,
    );
    await cdp.shot("calendar-board-wide");

    // A press outside it puts it away. The listener is in the capture phase, so
    // this runs before the calendar starts a gesture of its own.
    const outside = await cdp.eval(`(() => {
      const node = document.querySelector('[data-quick-add]');
      const box = node.getBoundingClientRect();
      return { x: Math.round(box.left + 4), y: Math.round(box.top + box.height / 2) };
    })()`);
    await cdp.mouse("mousePressed", outside.x, outside.y);
    await cdp.mouse("mouseReleased", outside.x, outside.y);
    await sleep(400);
    check("a press outside closes it", (await cdp.eval(`Boolean(document.querySelector('[data-event-editor]'))`)) === false);
    await cdp.eval(`document.querySelector('[data-quick-add]')?.blur()`);

    // Escape, which is the keyboard's way out of a form it did not mean to open.
    await cdp.mouse("mousePressed", openedBoard.x, openedBoard.y);
    await cdp.mouse("mouseReleased", openedBoard.x, openedBoard.y);
    await sleep(600);
    check("it opens again for the keyboard check", (await cdp.eval(`Boolean(document.querySelector('[data-event-editor]'))`)) === true);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await sleep(400);
    check("Escape closes it", (await cdp.eval(`Boolean(document.querySelector('[data-event-editor]'))`)) === false);
    check(
      "and Escape did not take the room with it",
      (await cdp.eval(`Boolean(document.querySelector('[data-calendar]'))`)) === true,
    );
    check("the room is still the calendar's", (await cdp.eval(`document.querySelector('[data-calendar]')?.dataset.view`)) !== undefined);

    /* ---------------- the phone ---------------- */

    section("At 390x844, with a finger");

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await sleep(600);
    check(
      "the browser reports a coarse pointer, which is what the grip law keys on",
      (await cdp.eval(`matchMedia('(pointer: coarse)').matches`)) === true,
    );

    /**
     * An empty patch of a column, as a point a finger can land on.
     *
     * Scanned inside the *visible* band of the scroller and across every column,
     * not down one column's whole day: a column is 24 hours tall and mostly
     * scrolled out of view, and `elementFromPoint` answers null above the
     * viewport — which is how an earlier version of this reported that there
     * was nowhere empty to press on a grid that was mostly empty.
     */
    const emptyPoint = () =>
      cdp.eval(`(() => {
        const scroller = document.querySelector('[data-time-scroll]');
        if (!scroller) return null;
        const view = scroller.getBoundingClientRect();
        for (const column of document.querySelectorAll('[data-column]')) {
          const box = column.getBoundingClientRect();
          const x = Math.round(box.left + box.width / 2);
          if (x < view.left + 2 || x > view.right - 2) continue;
          const from = Math.round(Math.max(box.top, view.top) + 16);
          const to = Math.round(Math.min(box.bottom, view.bottom) - 16);
          for (let y = from; y < to; y += 6) {
            if (document.elementFromPoint(x, y) === column) return { x, y };
          }
        }
        return null;
      })()`);

    const touchPoint = await emptyPoint();
    check("a touch has somewhere empty to land", touchPoint !== null);

    // The reported bug, as a finger performs it: a tap on empty grid. It used to
    // leave the drawn slot in the DOM for the rest of the session and open
    // nothing at all.
    await cdp.touch("touchStart", [touchPoint]);
    await sleep(60);
    await cdp.touch("touchEnd", []);
    await sleep(700);
    check(
      "a tap leaves no drop indicator behind",
      (await cdp.eval(`Boolean(document.querySelector('[data-drop-indicator]'))`)) === false,
    );
    const tapped = await board();
    check("and a tap opens the board where it landed", tapped !== null, JSON.stringify(tapped?.rect));
    check(
      "docked to the bottom edge, not floating off it",
      tapped !== null && tapped.bottom <= tapped.viewport[1] + 1 && tapped.bottom >= tapped.viewport[1] - 2,
      `bottom ${tapped?.bottom} of ${tapped?.viewport?.[1]}`,
    );
    check(
      "with every control inside the window and pressable",
      tapped !== null && tapped.controls.every((control) => control.inView && control.hittable),
      JSON.stringify(tapped?.controls?.filter((control) => !control.inView || !control.hittable)),
    );
    check(
      "and the board is behind a scrim, so a press anywhere else has somewhere to land",
      (await cdp.eval(`Boolean(document.querySelector('[data-editor-scrim]'))`)) === true,
    );
    await cdp.shot("calendar-phone-board");

    // A press on the scrim is the phone's "outside".
    const scrimBox = await cdp.eval(`(() => {
      const node = document.querySelector('[data-editor-scrim]');
      const box = node.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + 24) };
    })()`);
    await cdp.touch("touchStart", [scrimBox]);
    await sleep(60);
    await cdp.touch("touchEnd", []);
    await sleep(500);
    check("a press on the scrim puts the board away", (await cdp.eval(`Boolean(document.querySelector('[data-event-editor]'))`)) === false);

    // A swipe is a scroll. It must not draw anything and must not open a form.
    await cdp.touch("touchStart", [touchPoint]);
    for (let step = 1; step <= 5; step++) {
      await cdp.touch("touchMove", [{ x: touchPoint.x, y: touchPoint.y - step * 14 }]);
      await sleep(16);
    }
    await cdp.touch("touchEnd", []);
    await sleep(600);
    check(
      "a swipe draws nothing",
      (await cdp.eval(`Boolean(document.querySelector('[data-drop-indicator]'))`)) === false &&
        (await cdp.eval(`Boolean(document.querySelector('[data-event-editor]'))`)) === false,
    );

    /**
     * A short block, under a thumb.
     *
     * Measured before the fix: a 30-minute block at this size is 22px tall, two
     * fixed 14px grips covered 28px of it, and the body left for the move
     * gesture was minus six pixels. The law now is that a grip is only drawn
     * when it can leave the body its minimum, so a short block has none and the
     * whole of it moves.
     */
    const grips = await cdp.eval(`(() => {
      return [...document.querySelectorAll('[data-column] [data-event]')].map((block) => {
        const box = block.getBoundingClientRect();
        const handles = [...block.querySelectorAll('.cal-grip')];
        const thinnest = handles.length ? Math.min(...handles.map((h) => h.getBoundingClientRect().height)) : 0;
        return {
          minutes: Number(block.dataset.minutes),
          height: Math.round(box.height),
          handles: handles.length,
          grip: Math.round(thinnest),
          body: Math.round(box.height - handles.length * thinnest),
        };
      });
    })()`);
    check("the grid still has blocks to measure", grips.length > 0, String(grips.length));
    const shortBlocks = grips.filter((block) => block.height < 34);
    check(
      "a block too short to keep a body is given no grips at all",
      shortBlocks.every((block) => block.handles === 0),
      JSON.stringify(shortBlocks),
    );
    check(
      "so the whole of a short block is the move target",
      shortBlocks.every((block) => block.body === block.height),
      JSON.stringify(shortBlocks),
    );
    check(
      "and no block anywhere has a body smaller than the floor",
      grips.filter((block) => block.handles > 0).every((block) => block.body >= 18),
      JSON.stringify(grips.filter((block) => block.handles > 0 && block.body < 18)),
    );
    console.log(
      `  note  blocks at 390px: ${grips.map((b) => `${b.minutes}min ${b.height}px/${b.handles ? `${b.grip}px grips, ${b.body}px body` : "no grips"}`).join(", ")}`,
    );

    /* ---------------- and the point of taking the grips away ---------------- */

    /**
     * A 30-minute block under a thumb, moved.
     *
     * Omitting the grips is only correct if the gesture they were blocking now
     * works. Before the fix this block was 22px tall with two 14px handles over
     * it, so every press on it started a resize and the entry could not be moved
     * at all; the body was minus six pixels, measured. This presses where a
     * person would and checks both the grid and the database.
     */
    const shortSeedDay = await cdp.eval(`document.querySelector('[data-column][data-today="true"]')?.dataset.column ?? null`);
    const shortSeed = await api("event.create", {
      title: `${marker} short`,
      date: shortSeedDay,
      time: "10:00",
      minutes: 30,
    });
    /**
     * `api()` nests the answer under `body`, and this line used to read the
     * record off the wrapper.
     *
     * `shortSeed.event` is `undefined` — the record is at `shortSeed.body.event` —
     * so the id pushed into `created` was `undefined` and the lookup below it
     * resolved to nothing. It went unnoticed because the lookup then fell back to
     * "the first block with 30 minutes", which found *a* block and let the section
     * run; the cleanup swept by title, so the row was still removed. Now that the
     * seed is addressed by id there is no fallback left to hide it, which is how
     * a test's own typo surfaced as a product-looking failure about dragging.
     */
    const shortSeedId = shortSeed.body?.event?.id ?? "";
    if (shortSeedId) created.push(shortSeedId);
    // The room reads a window once and keeps it, so a row written straight to
    // the database is not on the grid until the window itself changes. Switching
    // to the day view is that change, and it is also the view this block wants:
    // one 326px column rather than seven 46px ones.
    await cdp.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Day')?.click()`);

    /**
     * Wait for the seeded block to actually be on the grid, by its own id.
     *
     * A fixed sleep is not enough, and this was measured rather than guessed: the
     * section used to seed a row, sleep, then look the block up by *id* with a
     * `??` fallback to "the first 30-minute block on the grid". Whenever the seed
     * had not rendered yet — which is what a real half-hour entry of the user's
     * own on the same day makes likely, because the day view then has several
     * candidates — the fallback quietly selected somebody else's event. The
     * section then dragged *that* block, compared its start against the seed's,
     * and reported "a finger on its body moves it" as a failure while the same
     * gesture against the same node succeeded in isolation.
     *
     * There is no fallback now. The seed's id is the only acceptable block, and
     * a seed that never appears fails here, by name, instead of twenty lines
     * later as a mystery about dragging.
     */
    let shortBlock = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const seen = await cdp.eval(`(() => {
        const block = document.querySelector('[data-event="${shortSeedId}"]');
        if (!block) return null;
        block.scrollIntoView({ block: 'center' });
        const box = block.getBoundingClientRect();
        const x = Math.round(box.left + box.width / 2);
        const y = Math.round(box.top + box.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
          id: block.dataset.event,
          start: block.dataset.start,
          height: Math.round(box.height),
          handles: block.querySelectorAll('.cal-grip').length,
          onBody: Boolean(hit && hit.closest('.cal-block') === block),
          x,
          y,
        };
      })()`);
      // Kept only when it is a real reading. The loop used to assign
      // unconditionally, so a final poll that happened to land in a render gap
      // wiped a perfectly good measurement and reported the block as missing.
      if (seen) {
        shortBlock = seen;
        break;
      }
      await sleep(120);
    }
    check(
      "the seeded block is on the grid under its own id",
      shortBlock?.id === shortSeedId && shortSeedId !== "",
      `wanted ${shortSeedId || "(no seed id returned)"}, got ${shortBlock?.id ?? "nothing"}`,
    );
    check("a 30-minute block is drawn at 390px", shortBlock !== null, JSON.stringify(shortBlock));
    check(
      "it has no resize handle anywhere on it",
      shortBlock !== null && shortBlock.handles === 0,
      `${shortBlock?.handles} handles on ${shortBlock?.height}px`,
    );
    check("so the middle of it is its own body", shortBlock?.onBody === true);
    console.log(
      `  note  the 30-minute block is ${shortBlock?.height}px tall with ${shortBlock?.handles ?? "?"} handles and ${shortBlock?.height ?? "?"}px of body`,
    );

    if (shortBlock) {
      /**
       * The press is aimed at the block's *current* box, re-read immediately
       * before the finger lands.
       *
       * The box measured above is already stale by the time this runs: an earlier
       * section swipes the grid vertically, which scrolls it, and a 30-minute
       * block is 22px tall in a 44px hour — so a scroll of a few dozen pixels is
       * enough to put the finger on the column beside it. Measuring at the moment
       * of the press is the whole fix, and the check below still refuses to run
       * if the point it computes is not over the block it means.
       */
      const aim = await cdp.eval(`(() => {
        const block = document.querySelector('[data-event="${shortBlock.id}"]');
        if (!block) return null;
        block.scrollIntoView({ block: 'center' });
        const box = block.getBoundingClientRect();
        const x = Math.round(box.left + box.width / 2);
        const y = Math.round(box.top + box.height / 2);
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          start: block.dataset.start,
          onBody: Boolean(hit && hit.closest('.cal-block') === block),
          height: Math.round(box.height),
        };
      })()`);
      check(
        "the finger lands on the block's own body at the moment of the press",
        aim?.onBody === true,
        JSON.stringify(aim),
      );
      shortBlock.start = aim?.start ?? shortBlock.start;

      await cdp.touch("touchStart", [{ x: aim.x, y: aim.y }]);
      await sleep(300);
      for (let step = 1; step <= 6; step++) {
        await cdp.touch("touchMove", [{ x: aim.x, y: aim.y + step * 8 }]);
        await sleep(18);
      }
      await cdp.touch("touchEnd", []);
      // The clock starts when the finger lifts, which is when the optimistic
      // grid already shows the drop and the server has not been asked yet. The
      // grid is read once React has committed that, then the database is polled
      // rather than slept at: the reported number is an upper bound on the round
      // trip, and a run where it stalls says so instead of failing on a race.
      const lifted = Date.now();
      await sleep(250);

      /**
       * The grid is polled for its new start rather than read once.
       *
       * The drop is optimistic, but the *attribute* is not: `data-start` is
       * written by React when it next renders the block, and one render is a
       * frame behind the drop. The single read that used to be here took the
       * pre-drop value whenever that frame had not happened yet, and the check
       * below then reported the block had not moved on a run where it plainly
       * had — reproduced against a block the finger moved from 14:00 to 15:00
       * while this line still said 14:00. Polling is the fix; the timeout is
       * only a backstop.
       */
      let onGrid = null;
      for (let attempt = 0; attempt < 25; attempt++) {
        onGrid = await cdp.eval(`document.querySelector('[data-event="${shortBlock.id}"]')?.dataset.start ?? null`);
        if (onGrid !== null && onGrid !== shortBlock.start) break;
        await sleep(60);
      }
      const settled = await settledStart(shortBlock.id, shortSeedDay, onGrid, lifted);
      check(
        "a finger on its body moves it, which it could not do before",
        onGrid !== null && onGrid !== shortBlock.start,
        `${shortBlock.start} -> ${onGrid} (after ${Date.now() - lifted}ms)`,
      );
      check(
        "and the clock the server kept agrees with the grid",
        settled.clock === onGrid,
        `${settled.clock} vs ${onGrid} after ${settled.waited}ms`,
      );
      console.log(`  note  the drop was in the database within ${settled.waited}ms of the finger lifting`);
    }

    /* ---------------- the swipe ---------------- */

    section("Turning the page with a finger, at 390x844");

    /**
     * The reported bug, as a person experiences it.
     *
     * "I cannot see tomorrow in the week since it is a Monday." The week was
     * drawn as seven columns inside a row pinned to `min-w-[560px]`, so on a
     * 390px screen each column measured 71px — and the run that established that
     * number also found the days past the fold sitting behind a horizontal scroll
     * nothing announced. Two things had to be true for this to be fixed, and both
     * are measured below: the columns have to be readable, and the week has to be
     * reachable by pushing it.
     */
    /**
     * Back to the week, with a real press.
     *
     * The drag above ended by swallowing the next click on the page in the
     * capture phase for 350ms — `swallowNextClick` doing its job on the click a
     * browser synthesises after a drop — and a programmatic `click()` here is
     * that next click, so it was eaten and the room stayed in the day view. The
     * wait below then gave up quietly and the whole swipe section ran against a
     * one-column grid. Waiting the window out and pressing through the browser is
     * what the neighbouring sections already do for the same reason.
     */
    await sleep(450);
    const weekChip = await cdp.eval(`(() => {
      const chip = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Week');
      if (!chip) return null;
      const box = chip.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    })()`);
    check("the Week chip is on screen to press", weekChip !== null, JSON.stringify(weekChip));
    if (weekChip) {
      await cdp.mouse("mousePressed", weekChip.x, weekChip.y);
      await cdp.mouse("mouseReleased", weekChip.x, weekChip.y);
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await cdp.eval(`document.querySelector('[data-calendar]')?.dataset.view`)) === "week") break;
      await sleep(100);
    }

    const readWeek = () =>
      cdp.eval(`(() => {
        const room = document.querySelector('[data-calendar]');
        const columns = [...document.querySelectorAll('[data-column]')];
        const scroller = document.querySelector('.cal-time')?.parentElement;
        const first = columns[0];
        return {
          view: room?.dataset.view,
          anchor: room?.dataset.anchor,
          window: room?.dataset.window,
          days: columns.map((node) => node.dataset.column),
          width: first ? Math.round(first.getBoundingClientRect().width) : 0,
          height: first ? Math.round(first.getBoundingClientRect().height) : 0,
          stage: Boolean(document.querySelector('.cal-stage')),
          // How many columns are inside the window rather than past its right edge.
          onScreen: columns.filter((node) => {
            const box = node.getBoundingClientRect();
            return box.right > 2 && box.left < innerWidth - 2;
          }).length,
          scrollable: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
        };
      })()`);

    const week = await readWeek();
    check("the week is drawn again", week.view === "week", JSON.stringify(week.view));
    check("with all seven days present", week.days.length === 7, JSON.stringify(week.days));
    await cdp.shot("calendar-phone-week");

    /**
     * Readability, which is the half of the bug that a swipe alone would not fix.
     *
     * The old layout gave each column 71px, measured — narrower than the clock
     * reading it has to print. The floor is asserted rather than the exact number
     * so a future tweak to `--cal-day-min` is not a test failure, while a return
     * to "seven slivers" is.
     */
    check(
      "each day is wide enough to read a time in",
      week.width >= 100,
      `${week.width}px per day (was 71px when seven were squeezed into 560px)`,
    );
    check(
      "and the week is a page-turn surface",
      week.stage === true,
      JSON.stringify({ stage: week.stage }),
    );
    console.log(
      `  note  the phone week: ${week.width}px per day, ${week.onScreen} of 7 columns on screen, ${week.scrollable}px of sideways scroll`,
    );

    // The exact thing the report was about: is tomorrow one of the days on
    // screen, or is it hidden past the edge?
    const tomorrow = await cdp.eval(`(() => {
      const room = document.querySelector('[data-calendar]');
      const today = room.dataset.anchor;
      const columns = [...document.querySelectorAll('[data-column]')];
      const tomorrowKey = columns.find((node) => node.dataset.column > today)?.dataset.column ?? '';
      const node = columns.find((n) => n.dataset.column === tomorrowKey);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        day: tomorrowKey,
        left: Math.round(box.left),
        right: Math.round(box.right),
        visible: box.left < innerWidth - 2 && box.right > 2,
        fullyVisible: box.left >= -1 && box.right <= innerWidth + 1,
      };
    })()`);
    check("tomorrow is a real column in this week", Boolean(tomorrow?.day), JSON.stringify(tomorrow));
    check(
      "and it is on screen without scrolling sideways",
      tomorrow?.visible === true,
      JSON.stringify(tomorrow),
    );

    /**
     * The swipe itself, as a finger performs it — a real `Input.dispatchTouchEvent`
     * sequence, not a synthesised `pointerdown`, because the whole gesture is a
     * question about what the *browser* does with a horizontal touch on a surface
     * that is `touch-action: pan-y`.
     *
     * A swipe to the left means "the next week". The anchor is the app's own
     * `data-anchor`, so this asserts what the calendar believes rather than what
     * a title string says.
     */
    const swipeAcross = async (fromX, toX, y, steps = 8) => {
      await cdp.touch("touchStart", [{ x: fromX, y }]);
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        await cdp.touch("touchMove", [{ x: fromX + (toX - fromX) * t, y }]);
        await sleep(12);
      }
      await cdp.touch("touchEnd", []);
    };

    const swipePoint = await cdp.eval(`(() => {
      const stage = document.querySelector('.cal-stage');
      if (!stage) return null;
      const box = stage.getBoundingClientRect();
      // Two thirds down the grid: inside the surface, and below the all-day lane
      // and the column heads, which are the two things that answer a press
      // themselves.
      return { y: Math.round(box.top + box.height * 0.7), mid: Math.round(innerWidth / 2) };
    })()`);
    check("a swipe has somewhere to start", swipePoint !== null, JSON.stringify(swipePoint));

    const beforeSwipe = await readWeek();
    await swipeAcross(swipePoint.mid + 90, swipePoint.mid - 90, swipePoint.y);
    await sleep(900);
    const afterSwipe = await readWeek();

    check(
      "a leftward swipe moves to the next week",
      afterSwipe.anchor !== beforeSwipe.anchor,
      `${beforeSwipe.anchor} -> ${afterSwipe.anchor}`,
    );
    check(
      "and it is exactly one week forward, not a month or a day",
      afterSwipe.window ===
        `${shiftDay(String(beforeSwipe.window).split("..")[0], 7)}..${shiftDay(String(beforeSwipe.window).split("..")[1], 7)}`,
      `${beforeSwipe.window} -> ${afterSwipe.window}`,
    );
    await cdp.shot("calendar-phone-swiped");

    // And back, which is the assertion that catches a one-way implementation.
    //
    // The swipe surface and the point are re-read rather than reused: a page turn
    // re-renders the grid for a different week, and a point measured against the
    // old layout is a finger landing somewhere that no longer exists. The wait is
    // longer than the turn's own animation by a wide margin, so a swipe that is
    // dropped because the previous one is still running cannot be mistaken for a
    // swipe that does not work.
    await sleep(500);
    const backPoint = await cdp.eval(`(() => {
      const stage = document.querySelector('.cal-stage');
      if (!stage) return null;
      const box = stage.getBoundingClientRect();
      return { y: Math.round(box.top + box.height * 0.7), mid: Math.round(innerWidth / 2) };
    })()`);
    await swipeAcross(backPoint.mid - 90, backPoint.mid + 90, backPoint.y);
    await sleep(900);
    const backAgain = await readWeek();
    check(
      "a rightward swipe returns to the week it came from",
      backAgain.anchor === beforeSwipe.anchor,
      `${afterSwipe.anchor} -> ${backAgain.anchor}, wanted ${beforeSwipe.anchor}`,
    );

    /**
     * A vertical swipe must still scroll.
     *
     * This is the trade the whole gesture design rests on: the day columns are 24
     * hours tall and scrolling them is the commonest thing a finger does here. A
     * page turn that stole a vertical drag would make the grid unscrollable on a
     * phone, which is a worse bug than the one being fixed.
     */
    const scrollBefore = await cdp.eval(`document.querySelector('[data-time-scroll]')?.scrollTop ?? -1`);
    await cdp.touch("touchStart", [{ x: swipePoint.mid, y: swipePoint.y }]);
    for (let step = 1; step <= 6; step++) {
      await cdp.touch("touchMove", [{ x: swipePoint.mid, y: swipePoint.y - step * 18 }]);
      await sleep(14);
    }
    await cdp.touch("touchEnd", []);
    await sleep(600);
    const scrollAfter = await cdp.eval(`document.querySelector('[data-time-scroll]')?.scrollTop ?? -1`);
    const afterVertical = await readWeek();
    check(
      "an upward swipe still scrolls the day",
      scrollAfter !== scrollBefore && scrollAfter > scrollBefore,
      `${scrollBefore} -> ${scrollAfter}`,
    );
    check(
      "and it did not also turn the page",
      afterVertical.anchor === beforeSwipe.anchor,
      `${afterVertical.anchor} vs ${beforeSwipe.anchor}`,
    );


    // The month, where the audit counted 44 controls under 24px in one axis.
    //
    // The drag above ended by swallowing the next click on the page, in the
    // capture phase, for 350ms — that is `swallowNextClick` doing its job on the
    // click a browser synthesises after a drop, and a programmatic click here is
    // the next click on the page. So the window is waited out, and then the grid
    // itself is waited for rather than slept at.
    await sleep(400);
    await cdp.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Month')?.click()`);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await cdp.eval(`Boolean(document.querySelector('.cal-month-grid'))`)) break;
      await sleep(150);
    }
    check("the Month view was selected at 390px", (await cdp.eval(`Boolean(document.querySelector('.cal-month-grid'))`)) === true);
    const monthSizes = await cdp.eval(`(() => {
      const root = document.querySelector('[data-calendar]');
      const cells = [...document.querySelectorAll('.cal-cell')];
      const controls = [...root.querySelectorAll('button')];
      const sizes = controls.map((node) => {
        const box = node.getBoundingClientRect();
        return { what: (typeof node.className === 'string' ? node.className.split(/\\s+/)[0] : ''), w: Math.round(box.width), h: Math.round(box.height) };
      });
      const small = sizes.filter((size) => size.w < 24 || size.h < 24);
      return {
        cells: cells.length,
        clipped: cells.filter((cell) => cell.scrollHeight > cell.clientHeight + 1).length,
        controls: sizes.length,
        small: small.length,
        kinds: [...new Set(small.map((size) => size.what))],
        grid: Math.round(document.querySelector('.cal-month-grid').getBoundingClientRect().height),
        viewport: innerHeight,
      };
    })()`);
    check("the month draws all six weeks", monthSizes.cells === 42, String(monthSizes.cells));
    check("and no cell has its content cut off", monthSizes.clipped === 0, `${monthSizes.clipped} clipped`);
    check(
      "no control in the month is under 24px in either axis",
      monthSizes.small === 0,
      `${monthSizes.small} of ${monthSizes.controls}: ${monthSizes.kinds.join(", ")}`,
    );

    /**
     * Growing the targets made the six weeks taller than a phone screen, which
     * is the trade the audit named. What must still be true is that the last
     * week is *reachable* rather than cut off: scroll to the bottom and check
     * the grid's foot is on screen. A `scrollHeight` bigger than the box is not
     * a failure on its own — a month that fits by shrinking its chips is.
     */
    const reach = await cdp.eval(`(() => {
      const grid = document.querySelector('.cal-month-grid');
      let node = grid.parentElement;
      while (node && node !== document.documentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) break;
        node = node.parentElement;
      }
      if (!node || node === document.documentElement) {
        return { over: 0, bottom: Math.round(grid.getBoundingClientRect().bottom), viewport: innerHeight, reachable: grid.getBoundingClientRect().bottom <= innerHeight + 1 };
      }
      const before = node.scrollTop;
      node.scrollTop = node.scrollHeight;
      const bottom = Math.round(grid.getBoundingClientRect().bottom);
      const over = node.scrollHeight - node.clientHeight;
      node.scrollTop = before;
      return { over, bottom, viewport: innerHeight, reachable: bottom <= innerHeight + 1 };
    })()`);
    check(
      "and the last week can be scrolled to rather than cut off",
      reach.reachable === true,
      JSON.stringify(reach),
    );
    console.log(
      `  note  six weeks are ${monthSizes.grid}px tall in a ${monthSizes.viewport}px window: ${reach.over}px of scroll on a phone, and every cell is whole`,
    );
    await cdp.shot("calendar-phone-month");

    // Back to where the rest of the suite expects to be.
    await cdp.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Day')?.click()`);
    await cdp.eval(`document.querySelector('[data-time-scroll]')?.scrollTo(0, 0)`);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(700);

    /* ---------------- console ---------------- */

    section("The console");
    check("no uncaught errors", consoleErrors.length === 0, consoleErrors.slice(0, 4).join(" | "));
    if (resourceErrors.length > 0) {
      console.log(`  note  ${resourceErrors.length} browser-profile noise item(s) ignored: ${resourceErrors[0]}`);
    }

    return fail === 0 ? 0 : 1;
  } finally {
    /* ---------------- put it back ---------------- */

    section("Cleaning up");

    /**
     * A window wide enough for anything this run could have touched.
     *
     * The drags move entries across weeks — the chip drag alone can land one six
     * weeks past the window the room opened on — so a sweep bounded by the
     * visible window misses exactly the entries that moved furthest, which is
     * how the first version of this left three rows in a real database while
     * reporting that it had cleaned up. Sixty days either side covers the whole
     * month grid and then some.
     */
    const sweepFrom = shiftDay(windowFrom, -60);
    const sweepTo = shiftDay(windowTo || windowFrom, 60);

    const rows = await range(sweepFrom, sweepTo).catch(() => []);
    const mine = rows.filter((event) => event.title.includes(marker));
    for (const id of new Set([...created, ...mine.map((event) => event.id)])) {
      await api("event.delete", { id });
      await api("trash.purge", { kind: "event", id });
    }
    const left = (await range(sweepFrom, sweepTo).catch(() => [])).filter((event) => event.title.includes(marker));
    check(`everything this run created is gone (${mine.length} swept)`, left.length === 0, left.map((e) => e.title).join(","));
    check("the screenshots are in data/shots", existsSync(OUT_DIR));
    socket.close();
  }
}

const code = await (async () => {
  try {
    return await main();
  } catch (err) {
    // The sections depend on each other: a block that was never drawn means the
    // drag below cannot be attempted, and saying so once is more useful than
    // twenty downstream failures about a missing element.
    console.log(`\n  FAIL  ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
})();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(code ?? 0);
