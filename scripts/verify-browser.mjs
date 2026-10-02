/**
 * Drive a real browser against the running app.
 *
 *   node scripts/verify-browser.mjs [baseUrl]
 *
 * Everything else in this repo checks bytes, modules or HTTP. This checks
 * the one thing none of those can: that the page actually *runs*. A canvas
 * that throws on its first frame, a client component that fails to hydrate,
 * a React error boundary swallowing a bad prop ?all of them look perfect
 * over `fetch` and are invisible to `tsc`.
 *
 * It launches Chromium (Edge or Chrome ?whichever is installed) headless
 * with the DevTools protocol on a port, then:
 *
 *   1. collects every console message and uncaught exception;
 *   2. screenshots the resting state;
 *   3. proves the orb canvas is actually painting, by reading its pixels;
 *   4. opens Settings through a real click and screenshots it;
 *   5. drives the theme picker and proves the document recolours;
 *   6. opens My cave and proves every room shows what the database holds;
 *   7. repeats at a phone viewport.
 *
 * Screenshots land in `data/shots/` so they are visible to a human
 * afterwards, which is the only way to judge whether it looks right.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Where to point the browser.
 *
 * The third argument wins, then `PORT` (which is what `npm run dev` itself
 * honours), then 4310 — the port `scripts/dev.mjs` starts on and prints. It
 * used to default to 4311, which nothing in this project serves: the script
 * found a browser, drove it at an address with no Xana on it, and every check
 * downstream would have failed for a reason that had nothing to do with the
 * app. It was never noticed because the environment here cannot launch a
 * browser at all, so the wrong default was never exercised.
 */
const base = process.argv[2] ?? `http://127.0.0.1:${process.env.PORT ?? "4310"}`;
const OUT_DIR = join(process.cwd(), "data", "shots");
const PORT = 9222;

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` ?${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${"─".repeat(64)}\n${title}\n${"─".repeat(64)}`);
}

/* ------------------------------------------------------------------ */
/* Finding a browser                                                  */
/* ------------------------------------------------------------------ */

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
    : null,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findBrowser() {
  for (const candidate of CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* A very small CDP client                                            */
/* ------------------------------------------------------------------ */

class Devtools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();

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

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  /** Resolve with the next matching event, or null on timeout. */
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

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/* ------------------------------------------------------------------ */
/* Page helpers                                                       */
/* ------------------------------------------------------------------ */

async function evaluate(devtools, sessionId, expression, awaitPromise = false) {
  const result = await devtools.send(
    "Runtime.evaluate",
    { expression, awaitPromise, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "evaluate threw",
    );
  }
  return result.result?.value;
}

async function screenshot(devtools, sessionId, name) {
  const shot = await devtools.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false },
    sessionId,
  );
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${name}.png`);
  writeFileSync(path, Buffer.from(shot.data, "base64"));
  return path;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

/**
 * Is Xana actually answering at the target?
 *
 * Asked before a browser is launched, and the order matters. The script skips
 * when the *environment* cannot host a browser; this is the other bad start —
 * a perfectly good environment with no server on the target port. Without this
 * check the browser opens at a dead address, every assertion downstream fails,
 * and the report reads like the app is broken when the app is simply not
 * running. On a machine where `npm run dev` picked a different port, the same
 * thing happens with a URL that looks right.
 *
 * `npm run dev` prints the port it chose; this prints the one it looked for.
 */
async function targetAnswers() {
  try {
    const response = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return { ok: false, detail: `answered ${response.status}` };
    const body = await response.json();
    // The same shape `dev.mjs` uses to recognise an Xana already listening:
    // "something is on this port" is not the same as "Xana is".
    if (typeof body?.partOfDay !== "string" || typeof body?.energy?.band !== "string") {
      return { ok: false, detail: "something is answering, but it is not Xana" };
    }
    return { ok: true, detail: `${body.partOfDay}, energy ${body.energy.band}` };
  } catch (err) {
    return { ok: false, detail: err?.name === "TimeoutError" ? "timed out" : "nothing is listening" };
  }
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log("No Chromium-based browser found. Skipping browser verification.");
    console.log("Set CHROME_PATH to run it.");
    return;
  }

  const target = await targetAnswers();
  if (!target.ok) {
    console.log(`\n  Cannot verify ${base} — ${target.detail}.`);
    console.log(`\n  Start Xana first, in another terminal:`);
    console.log(`      npm run dev`);
    console.log(`\n  It prints the port it chose. If that is not 4310, pass it here:`);
    console.log(`      npm run verify:browser -- http://127.0.0.1:<port>`);
    console.log(`  or set PORT to the same value in both. Nothing was launched,`);
    console.log(`  so this is a skip rather than a failure — but it is not a pass.\n`);
    return;
  }

  const userDataDir = join(process.cwd(), "data", "browser-profile");
  mkdirSync(userDataDir, { recursive: true });

  console.log(`Browser   ${browserPath}`);
  console.log(`Target    ${base}  (${target.detail})`);

  let child;
  try {
    child = spawn(
      browserPath,
      [
        "--headless=new",
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-features=Translate,OptimizationHints",
        // A deterministic viewport, so the screenshots are comparable run
        // to run and the responsive assertions mean something.
        "--window-size=1440,900",
        "about:blank",
      ],
      // Stderr is piped so a browser that dies on launch can be diagnosed:
      // "DevTools never answered" is not a useful error message.
      { stdio: ["ignore", "ignore", "pipe"], detached: false },
    );
  } catch (err) {
    /**
     * Some sandboxes deny process creation outright. Chromium cannot exist
     * under one ?it is a multi-process application by design, and its IPC
     * is built on named pipes. Report it as a skip with the reason, because
     * the alternative is an EPERM that reads like a defect in the app.
     */
    if (err && err.code === "EPERM") {
      skipHostileEnvironment();
      return;
    }
    throw err;
  }
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => {
    diagnostics += chunk.toString();
    if (diagnostics.length > 8000) diagnostics = diagnostics.slice(-8000);
  });

  let socket;
  try {
    socket = await connectWithRetry();
  } catch (err) {
    child.kill();

    if (/platform_channel|mojo|Access is denied|crashpad/i.test(diagnostics)) {
      skipHostileEnvironment(child);
      return;
    }

    throw err;
  }

  const devtools = new Devtools(socket);

  const problems = [];
  devtools.on((message) => {
    if (message.method === "Runtime.consoleAPICalled") {
      const { type, args } = message.params;
      if (type !== "error" && type !== "warning" && type !== "assert") return;
      const text = args
        .map((a) => a.value ?? a.description ?? a.type)
        .join(" ")
        .slice(0, 300);
      // React's dev-mode StrictMode notice and Turbopack's HMR chatter are
      // not defects; everything else is.
      if (/Download the React DevTools|Fast Refresh/i.test(text)) return;
      problems.push(`${type}: ${text}`);
    }
    if (message.method === "Runtime.exceptionThrown") {
      const d = message.params.exceptionDetails;
      problems.push(
        `exception: ${d.exception?.description ?? d.text ?? "unknown"}`.slice(0, 400),
      );
    }
    if (message.method === "Log.entryAdded") {
      const { level, text, url } = message.params.entry;
      // The URL is a separate field, and the failure text — "Failed to load
      // resource: the server responded with a status of 404" — never contains
      // it. Filtering on the text alone let the favicon through and reported a
      // console error on every run, which is the shape of a check nobody
      // believes any more.
      const favicon = /favicon/i.test(text) || /favicon/i.test(url ?? "");
      if (level === "error" && !favicon) {
        problems.push(`log: ${text}${url ? ` (${url})` : ""}`.slice(0, 300));
      }
    }
  });

  try {
    /* ---------------- desktop ---------------- */
    section("Desktop · 1440×900");

    /* No width/height here. Passing them asks the browser for a *popup*
       window, and a current Edge answers "Target position can only be set for
       new windows" and refuses to open a target at all — which is what this
       script did the first time it ever ran on a machine that could launch a
       browser, having been written where none could. The window size comes
       from `--window-size` on the launch, and the phone section overrides the
       metrics explicitly. */
    const { targetId } = await devtools.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await devtools.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });

    await devtools.send("Page.enable", {}, sessionId);
    await devtools.send("Runtime.enable", {}, sessionId);
    await devtools.send("Log.enable", {}, sessionId);

    const loaded = devtools.once("Page.loadEventFired");
    await devtools.send("Page.navigate", { url: base }, sessionId);
    await loaded;

    // The orb starts its loop on mount and the ambient poll settles after
    // one request; give both a moment before judging the paint.
    await sleep(2500);

    check("the page loaded", (await evaluate(devtools, sessionId, "document.readyState")) === "complete");

    const hydrated = await evaluate(
      devtools,
      sessionId,
      "Boolean(document.querySelector('canvas')?.getContext)",
    );
    check("the client bundle hydrated", hydrated === true);

    // A canvas that exists but never painted is the exact failure a
    // fetch-based check cannot see. Read the pixels back instead.
    const painted = await evaluate(
      devtools,
      sessionId,
      `(() => {
        const canvas = document.querySelector('.orb canvas');
        if (!canvas) return { error: 'no canvas' };
        const ctx = canvas.getContext('2d');
        const { width, height } = canvas;
        if (!width || !height) return { error: 'zero-sized canvas' };
        const data = ctx.getImageData(0, 0, width, height).data;
        let lit = 0, maxAlpha = 0, sumX = 0, sumY = 0;
        for (let i = 3; i < data.length; i += 4) {
          const a = data[i];
          if (a > 8) {
            lit++;
            const px = ((i - 3) / 4) % width;
            const py = Math.floor((i - 3) / 4 / width);
            sumX += px; sumY += py;
          }
          if (a > maxAlpha) maxAlpha = a;
        }
        return {
          width, height,
          lit,
          coverage: lit / (width * height),
          maxAlpha,
          centroidX: lit ? sumX / lit / width : 0,
          centroidY: lit ? sumY / lit / height : 0,
        };
      })()`,
    );

    if (painted?.error) {
      check("the orb canvas is painting", false, painted.error);
    } else {
      check(
        "the orb canvas is painting",
        painted.lit > 500 && painted.maxAlpha > 40,
        `lit=${painted.lit} maxAlpha=${painted.maxAlpha}`,
      );
      check(
        "the orb covers a plausible area",
        painted.coverage > 0.02 && painted.coverage < 0.85,
        `coverage=${(painted.coverage * 100).toFixed(1)}%`,
      );
      // A shell drawn off-centre is the classic transform/DPR bug.
      check(
        "the orb is centred in its canvas",
        Math.abs(painted.centroidX - 0.5) < 0.09 && Math.abs(painted.centroidY - 0.5) < 0.09,
        `centroid=(${painted.centroidX.toFixed(2)}, ${painted.centroidY.toFixed(2)})`,
      );
      console.log(
        `  info  canvas ${painted.width}×${painted.height}, ${painted.lit} lit pixels`,
      );
    }

    // The orb must actually move. Two frames a beat apart must differ.
    const before = await evaluate(
      devtools,
      sessionId,
      `(() => {
        const c = document.querySelector('.orb canvas');
        return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.join(',').length;
      })()`,
    );
    const sampleA = await evaluate(
      devtools,
      sessionId,
      `(() => {
        const c = document.querySelector('.orb canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0;
        return h;
      })()`,
    );
    await sleep(700);
    const sampleB = await evaluate(
      devtools,
      sessionId,
      `(() => {
        const c = document.querySelector('.orb canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0;
        return h;
      })()`,
    );
    check(
      "the orb is animating",
      sampleA !== sampleB,
      `two frames hashed identically (${sampleA} vs ${sampleB})`,
    );
    void before;

    const shot1 = await screenshot(devtools, sessionId, "01-desktop-idle");
    console.log(`  info  ${shot1}`);

    // The theme tokens must be readable from the document the canvas reads.
    const tokens = await evaluate(
      devtools,
      sessionId,
      `(() => {
        const s = getComputedStyle(document.documentElement);
        return {
          accent: s.getPropertyValue('--accent-rgb').trim(),
          accent2: s.getPropertyValue('--accent-2-rgb').trim(),
          motion: s.getPropertyValue('--motion').trim(),
          ambient: s.getPropertyValue('--ambient-glow').trim(),
        };
      })()`,
    );
    check("the accent token resolves", /^\d+ \d+ \d+$/.test(tokens?.accent ?? ""), tokens?.accent);
    check("the secondary accent resolves", /^\d+ \d+ \d+$/.test(tokens?.accent2 ?? ""), tokens?.accent2);
    check("the motion token resolves", Number(tokens?.motion) > 0, tokens?.motion);

    /* ---------------- settings ---------------- */
    section("Settings, opened by a real click");

    // Snapshot the appearance before touching it. The theme picker below is
    // exercised for real, and the settings file is the user's own state, not
    // a fixture — so what was there has to be read first and put back after.
    const appearanceBefore = await fetch(`${base}/api/settings`, { cache: "no-store" })
      .then((res) => res.json())
      .then((payload) => payload.settings.appearance)
      .catch(() => ({ theme: "xana", accent: "111 227 227", accent2: "156 140 255", ambient: 0.13, motionSpeed: 1 }));

    const opened = await evaluate(
      devtools,
      sessionId,
      `(() => {
        const buttons = [...document.querySelectorAll('button')];
        const settings = buttons.find((b) => /settings/i.test(b.getAttribute('aria-label') || b.textContent || ''));
        if (!settings) return 'no settings button';
        settings.click();
        return 'clicked';
      })()`,
    );
    check("found and clicked the settings button", opened === "clicked", opened);
    await sleep(1400);

    const dialog = await evaluate(
      devtools,
      sessionId,
      `(() => {
        const d = document.querySelector('[role="dialog"]');
        if (!d) return { open: false };
        return {
          open: true,
          labelled: Boolean(d.getAttribute('aria-labelledby')),
          modal: d.getAttribute('aria-modal') === 'true',
          tabs: [...d.querySelectorAll('[role="tab"]')]
            // The sheet renders both its desktop rail and its phone strip, and
            // only one of them is visible: counting the DOM gave ten sections
            // for the five the panel has, and this assertion failed the first
            // time the script ever ran somewhere a browser could start.
            .filter((t) => t.getBoundingClientRect().width > 0)
            .map((t) => t.textContent.trim()),
          focusInside: d.contains(document.activeElement),
          swatches: d.querySelectorAll('[role="radiogroup"] button').length,
        };
      })()`,
    );
    check("a dialog opened", dialog?.open === true);
    check("the dialog is labelled", dialog?.labelled === true);
    check("the dialog is modal", dialog?.modal === true);
    check("it has the sections", (dialog?.tabs?.length ?? 0) === 5, JSON.stringify(dialog?.tabs));
    check("focus moved into the dialog", dialog?.focusInside === true);
    check("the theme presets are rendered", dialog?.swatches === 6, String(dialog?.swatches));

    const shot2 = await screenshot(devtools, sessionId, "02-desktop-settings");
    console.log(`  info  ${shot2}`);

    // Pick a theme that is not the one already in force, and prove the
    // document recoloured and that the canvas picked the new accent up out of
    // computed style.
    //
    // It used to click the "ember" preset by name, which proves nothing on a
    // machine that is already on ember — the accent is the same before and
    // after, and the check reads as "the picker is broken" when the picker was
    // never asked to change anything. Which preset is current is the machine's
    // business, so the script asks for a different one instead of naming one.
    const recoloured = await evaluate(
      devtools,
      sessionId,
      `(async () => {
        const before = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
        const swatches = [...document.querySelectorAll('[role="radiogroup"] button')].filter(
          (b) => b.getBoundingClientRect().width > 0,
        );
        const other = swatches.find((b) => b.getAttribute('aria-pressed') !== 'true');
        if (!other) return { error: 'every preset is already selected' };
        const label = (other.textContent || '').trim().split('\\n')[0];
        other.click();
        await new Promise((r) => setTimeout(r, 500));
        const after = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
        return { before, after, label, changed: before !== after, press: other.getAttribute('aria-pressed') };
      })()`,
      true,
    );

    if (recoloured?.error) {
      check("the theme picker recolours the document", false, recoloured.error);
    } else {
      check("the theme picker recolours the document", recoloured.changed === true, `${recoloured.before} -> ${recoloured.after}`);
      check("the preset reads as selected", recoloured.press === "true");
      console.log(`  info  ${recoloured.label}: accent ${recoloured.before} -> ${recoloured.after}`);
    }

    await sleep(1600);
    const shot3 = await screenshot(devtools, sessionId, "03-desktop-theme");
    console.log(`  info  ${shot3}`);

    // Walk the other tabs, which is where an unrendered card or a bad prop
    // would surface.
    const tabReports = [];
    for (const label of ["Voice", "Model & key", "Connections", "About"]) {
      const report = await evaluate(
        devtools,
        sessionId,
        `(async () => {
          const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === ${JSON.stringify(label)});
          if (!tab) return { label: ${JSON.stringify(label)}, found: false };
          tab.click();
          await new Promise((r) => setTimeout(r, 450));
          const panel = document.querySelector('[role="tabpanel"]');
          return {
            label: ${JSON.stringify(label)},
            found: true,
            text: (panel?.innerText || '').length,
            controls: panel?.querySelectorAll('input, select, textarea, button').length ?? 0,
          };
        })()`,
        true,
      );
      tabReports.push(report);
      if (report?.found && report.text < 40) {
        check(`${label} panel renders content`, false, `${report.text} chars`);
      }
    }
    check(
      "every settings tab renders content",
      tabReports.every((r) => r.found && r.text >= 40),
      JSON.stringify(tabReports.map((r) => `${r.label}:${r.text}`)),
    );

    /* The room to breathe, driven through the real form.
     *
     * `verify:pause` proves the rule and the store; this proves the third
     * hand-written layer, the panel. A slider whose value never reaches the
     * store behaves exactly like a working setting until somebody speaks to her,
     * and that is not a thing to discover by talking. It writes 5.0s, saves,
     * reads the setting back from the API, and then puts back the value it
     * found — the same discipline the cave's writes follow, because this is the
     * owner's real machine and their real settings file. */
    const pauseBefore = await evaluate(
      devtools,
      sessionId,
      `fetch('/api/settings').then((r) => r.json()).then((s) => s.settings.voice.pauseMs)`,
      true,
    );
    const pauseRound = await evaluate(
      devtools,
      sessionId,
      `(async () => {
        const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === 'Voice');
        if (!tab) return { found: false };
        tab.click();
        await new Promise((r) => setTimeout(r, 400));
        const panel = document.querySelector('[role="tabpanel"]');
        const label = [...(panel?.querySelectorAll('label') || [])].find((l) => l.textContent.trim() === 'Room to breathe');
        const input = label ? document.getElementById(label.htmlFor) : null;
        if (!input) return { found: false };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const set = (value) => {
          setter.call(input, String(value));
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const save = () => {
          const button = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save voice');
          button?.click();
          return Boolean(button);
        };
        const stored = async () => (await (await fetch('/api/settings')).json()).settings.voice.pauseMs;
        const shown = panel.innerText.includes((input.valueAsNumber).toFixed(1) + 's');
        set(5);
        await new Promise((r) => setTimeout(r, 250));
        const clicked = save();
        await new Promise((r) => setTimeout(r, 900));
        const written = await stored();
        set(${(Number(pauseBefore) || 4_000) / 1000});
        await new Promise((r) => setTimeout(r, 250));
        save();
        await new Promise((r) => setTimeout(r, 900));
        return { found: true, shown, clicked, written, restored: await stored() };
      })()`,
      true,
    );
    check("the voice panel has the room-to-breathe slider", Boolean(pauseRound?.found));
    check("it renders the stored value", Boolean(pauseRound?.shown));
    check("saving it writes the setting", pauseRound?.written === 5000, `${pauseRound?.written}`);
    check(
      "and the value it found is put back",
      pauseRound?.restored === pauseBefore,
      `${pauseRound?.restored} vs ${pauseBefore}`,
    );

    const shotAbout = await screenshot(devtools, sessionId, "04-desktop-about");
    console.log(`  info  ${shotAbout}`);

    // Escape must close it ?the keyboard path, not the click path.
    const closed = await evaluate(
      devtools,
      sessionId,
      `(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 500));
        return Boolean(document.querySelector('[role="dialog"]'));
      })()`,
      true,
    );
    check("Escape closes the dialog", closed === false);

    // Put the appearance back so the repo is left as it was found.
    //
    // This used to hardcode `theme: "xana"`, which is only correct if that is
    // what was there to begin with. On a machine where this script actually
    // runs, that silently replaced the user's own theme every time — and
    // because the settings file is real state rather than a fixture, the
    // damage looked like the app forgetting a preference.
    await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        settings: {
          appearance: {
            theme: appearanceBefore.theme,
            accent: appearanceBefore.accent,
            accent2: appearanceBefore.accent2,
            ambient: appearanceBefore.ambient,
            motionSpeed: appearanceBefore.motionSpeed,
          },
        },
      }),
    });

    /* ---------------- a conversation ---------------- */
    section("A turn, driven through the UI");

    const sent = await evaluate(
      devtools,
      sessionId,
      `(async () => {
        const field = document.querySelector('textarea');
        if (!field) return 'no composer';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(field, 'what is on today');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 120));
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'sent';
      })()`,
      true,
    );
    check("the composer accepted a turn", sent === "sent", sent);
    await sleep(3500);

    const turn = await evaluate(
      devtools,
      sessionId,
      `(() => {
        const cards = document.querySelectorAll('section.card');
        return {
          text: document.body.innerText.length,
          cards: cards.length,
          sparkline: document.querySelectorAll('.skeleton').length,
        };
      })()`,
    );
    check("the reply rendered", (turn?.text ?? 0) > 400, `${turn?.text} chars`);
    console.log(`  info  ${turn?.cards ?? 0} card(s) in the transcript`);
    const shot4 = await screenshot(devtools, sessionId, "05-desktop-turn");
    console.log(`  info  ${shot4}`);

    /* ---------------- My cave ---------------- */
    section("My cave, opened by a real click");

    // What the cave is supposed to hold, read from Node rather than from the
    // page. A client that renders the same wrong answer twice still agrees
    // with itself, so the comparison has to come from outside it.
    const caveExpected = await fetch(`${base}/api/cave`, { cache: "no-store" }).then((r) => r.json());

    /** Open the cave through the header button. */
    const openCave = () =>
      evaluate(
        devtools,
        sessionId,
        `(async () => {
          const button = [...document.querySelectorAll('button')].find((b) => /my cave/i.test(b.textContent || ''));
          if (!button) return { found: false };
          button.click();
          await new Promise((r) => setTimeout(r, 250));
          const panel = document.querySelector('[role="dialog"]');
          return {
            found: true,
            open: Boolean(panel),
            rooms: panel
              ? [...panel.querySelectorAll('[role="tab"]')]
                  .filter((t) => t.getBoundingClientRect().width > 0)
                  .map((t) => t.textContent.trim())
              : [],
          };
        })()`,
        true,
      );

    /** The cave's own text, never the page behind it. */
    const caveText = () =>
      evaluate(devtools, sessionId, `document.querySelector('[role="dialog"]')?.innerText ?? ''`);

    /** Click a room and return what it says. */
    const enterRoom = (label) =>
      evaluate(
        devtools,
        sessionId,
        `(async () => {
          const panel = document.querySelector('[role="dialog"]');
          if (!panel) return '';
          const tab = [...panel.querySelectorAll('[role="tab"]')].find(
            (t) => t.textContent.trim() === ${JSON.stringify(label)} && t.getBoundingClientRect().width > 0,
          );
          if (!tab) return '';
          tab.click();
          await new Promise((r) => setTimeout(r, 400));
          return panel.innerText;
        })()`,
        true,
      );

    const caveOpened = await openCave();
    check("the header button opens My cave", caveOpened?.open === true, JSON.stringify(caveOpened));
    check(
      "every room is in the strip",
      ["Goals", "Tasks", "Schedule", "Log", "Memory", "Trash"].every((room) =>
        (caveOpened?.rooms ?? []).includes(room),
      ),
      JSON.stringify(caveOpened?.rooms),
    );

    // Wait for the cave's own read to land rather than sleeping a fixed
    // time. "Reading…" is the state the rooms are in until the fetch
    // answers, and asserting on a timer would be a race with the network.
    let goalsRoom = "";
    for (let i = 0; i < 25; i += 1) {
      goalsRoom = await caveText();
      if (goalsRoom && !goalsRoom.includes("Reading…")) break;
      await sleep(300);
    }

    check(
      "the cave stops saying it is reading",
      goalsRoom.length > 0 && !goalsRoom.includes("Reading…"),
      goalsRoom.slice(0, 120),
    );

    /**
     * The check this section exists for.
     *
     * The cave used to render the empty state its state started in and never
     * send the request at all: a database with three goals and an open task
     * showed "Nothing on the board yet" in the rooms while the front page
     * listed them. Nothing in this repo could see it — the API was right, the
     * types were right, and the component rendered exactly what it was given.
     */
    const activeGoals = caveExpected.goals.filter((entry) => entry.goal.status === "active");
    if (activeGoals.length > 0) {
      const missing = activeGoals.filter((entry) => !goalsRoom.includes(entry.goal.title));
      check(
        `the board shows the ${activeGoals.length} goal${activeGoals.length === 1 ? "" : "s"} in the database`,
        missing.length === 0,
        missing.length
          ? `not rendered: ${missing.map((entry) => entry.goal.title).join(", ")}`
          : "the room was empty",
      );
      check("and does not claim the board is empty", !goalsRoom.includes("Nothing on the board yet"));
      check(
        "the summary counts them",
        goalsRoom.includes(`${activeGoals.length} in play`),
        goalsRoom.split("\n").slice(0, 3).join(" / "),
      );
    } else {
      console.log("  info  no active goals in this database; the empty state is asserted instead");
      check("an empty board says so", goalsRoom.includes("Nothing on the board yet"));
    }

    const shotCaveGoals = await screenshot(devtools, sessionId, "07-cave-goals");
    console.log(`  info  ${shotCaveGoals}`);

    const tasksRoom = await enterRoom("Tasks");
    const openTasks = caveExpected.tasks.filter((task) => task.status === "open");
    if (openTasks.length > 0) {
      const missing = openTasks.filter((task) => !tasksRoom.includes(task.title));
      check(
        `the task room shows the ${openTasks.length} open task${openTasks.length === 1 ? "" : "s"} in the database`,
        missing.length === 0,
        missing.length ? `not rendered: ${missing.map((task) => task.title).join(", ")}` : "the room was empty",
      );
      check("and does not claim nothing is open", !tasksRoom.includes("Nothing open."));
    } else {
      check("an empty list says so", tasksRoom.includes("Nothing open."));
    }
    const shotCaveTasks = await screenshot(devtools, sessionId, "08-cave-tasks");
    console.log(`  info  ${shotCaveTasks}`);

    const memories = caveExpected.memories?.items ?? [];
    const memoryRoom = await enterRoom("Memory");
    if (memories.length > 0) {
      check(
        `the memory room shows the ${memories.length} memories in the database`,
        memoryRoom.includes(memories[0].title),
        memoryRoom.slice(0, 160),
      );
      check("and does not claim nothing is remembered", !memoryRoom.includes("Nothing remembered yet"));
    } else {
      check("an empty memory room says so", memoryRoom.includes("Nothing remembered yet"));
    }

    const trashRoom = await enterRoom("Trash");
    if (caveExpected.trash.length > 0) {
      const missing = caveExpected.trash.filter((item) => !trashRoom.includes(item.title));
      check(
        `the bin lists the ${caveExpected.trash.length} item${caveExpected.trash.length === 1 ? "" : "s"} in the database`,
        missing.length === 0,
        missing.length ? `not rendered: ${missing.map((item) => item.title).join(", ")}` : "the bin was empty",
      );
    } else {
      check("an empty bin says so", trashRoom.includes("Empty."));
    }

    /* ---- a change made behind the cave's back must appear on re-open ---- */
    const probeTitle = `browser-probe-${Date.now().toString(36)}`;
    const probe = await fetch(`${base}/api/cave`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "task.create", title: probeTitle }),
    }).then((r) => r.json());
    const probeId = probe.task?.id;
    check("a task can be added behind the cave's back", Boolean(probeId));

    // Close, re-open, and the list has to have moved on. This is the other
    // half of the contract: reading once per mount would leave the board
    // wrong for the rest of the session, which is the same bug wearing a
    // different hat.
    const caveClosed = await evaluate(
      devtools,
      sessionId,
      `(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        return Boolean(document.querySelector('[role="dialog"]'));
      })()`,
      true,
    );
    check("Escape closes the cave", caveClosed === false);

    await openCave();
    // The cave opens on the goal board, and the probe is a task, so the room
    // has to be entered before the assertion means anything. Asking the goals
    // room whether it can see a task fails whatever the app does.
    await enterRoom("Tasks");
    let reopened = "";
    for (let i = 0; i < 25; i += 1) {
      reopened = await caveText();
      if (reopened.includes(probeTitle)) break;
      await sleep(300);
    }
    check("re-opening re-reads the board", reopened.includes(probeTitle), reopened.slice(0, 160));

    // Leave the database as it was found: the probe is deleted (which puts
    // it in the bin) and then purged from the bin, so it does not sit in the
    // user's trash for a week.
    await fetch(`${base}/api/cave`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "task.delete", id: probeId }),
    });
    await fetch(`${base}/api/cave`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "trash.purge", kind: "task", id: probeId }),
    });
    const after = await fetch(`${base}/api/cave`, { cache: "no-store" }).then((r) => r.json());
    check(
      "the probe is gone from the list and from the bin",
      !after.tasks.some((task) => task.id === probeId) && !after.trash.some((item) => item.id === probeId),
    );

    /* ---- a deleted goal is one row, and deleting it takes its steps ---- */
    //
    // The bin used to list a goal's milestones as rows of their own. That
    // looked honest and produced two actions that could only end badly:
    // restoring a step put back a milestone whose goal was still in the bin,
    // and deleting the goal for good left its steps behind. The row is now the
    // goal, it says how many steps came with it, and purging it purges them —
    // through the room's own button, because that is the path a person takes.
    const goalTitle = `browser-goal-${Date.now().toString(36)}`;
    await fetch(`${base}/api/cave`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "goal.create",
        title: goalTitle,
        horizon: "short",
        milestones: ["first step", "second step"],
      }),
    });
    const createdBoard = await fetch(`${base}/api/cave`, { cache: "no-store" }).then((r) => r.json());
    const probeGoal = createdBoard.goals.find((entry) => entry.goal.title === goalTitle);
    const probeStepIds = (probeGoal?.goal.milestones ?? []).map((step) => step.id);
    check("a goal with two steps can be created behind the cave's back", probeStepIds.length === 2);

    await fetch(`${base}/api/cave`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "goal.delete", id: probeGoal?.goal.id }),
    });

    // Close and re-open: the cave reads on open, which is also how the bin it
    // is about to show gets its data.
    await evaluate(
      devtools,
      sessionId,
      `(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
      })()`,
      true,
    );
    await openCave();
    const binRoom = await enterRoom("Trash");
    check(
      "the bin shows the deleted goal under its own name",
      binRoom.includes(goalTitle),
      binRoom.slice(0, 200),
    );
    check(
      "and says how many steps came with it",
      /2 steps with it/.test(binRoom),
      binRoom.split("\n").find((line) => line.includes("removed")) ?? binRoom.slice(0, 200),
    );
    check(
      "the steps are not listed as rows of their own",
      !binRoom.includes("first step") && !binRoom.includes("second step"),
    );
    const shotCaveBin = await screenshot(devtools, sessionId, "09-cave-bin");
    console.log(`  info  ${shotCaveBin}`);

    const purgedFromRoom = await evaluate(
      devtools,
      sessionId,
      `(async () => {
        const panel = document.querySelector('[role="dialog"]');
        const row = [...panel.querySelectorAll('li')].find((li) => li.innerText.includes(${JSON.stringify(goalTitle)}));
        if (!row) return { found: false };
        const button = [...row.querySelectorAll('button')].find((b) => /delete for good/i.test(b.textContent || ''));
        if (!button) return { found: true, button: false };
        button.click();
        await new Promise((r) => setTimeout(r, 900));
        return { found: true, button: true, text: panel.innerText };
      })()`,
      true,
    );
    check("the row offers Delete for good", purgedFromRoom?.button === true, JSON.stringify(purgedFromRoom?.found));
    /**
     * The goal is gone from the bin — and that is the whole assertion.
     *
     * It used to also require the room to say "Empty.", which is a fact about
     * *this database*, not about the button: on a machine whose bin holds
     * ninety-odd rows from an earlier clearing, a working delete was reported as
     * a failure because the room was not empty afterwards. A check that only
     * passes on a fresh install is a check that will one day be deleted for
     * being wrong, and this one was wrong first.
     */
    check(
      "clicking it takes the goal out of the bin",
      purgedFromRoom?.text?.includes("TRASH") === true && !purgedFromRoom.text.includes(goalTitle),
      purgedFromRoom?.text?.includes(goalTitle) ? "the row is still listed" : "the room stopped rendering",
    );

    const stepRestore = await fetch(`${base}/api/cave`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "trash.restore", kind: "milestone", id: probeStepIds[0] }),
    });
    check(
      "and its steps are gone for good, not merely hidden",
      stepRestore.status === 404,
      `trash.restore answered ${stepRestore.status}`,
    );

    const finalBoard = await fetch(`${base}/api/cave`, { cache: "no-store" }).then((r) => r.json());
    check(
      "the database is left as it was found",
      !finalBoard.goals.some((entry) => entry.goal.title === goalTitle) &&
        !finalBoard.trash.some((item) => item.title === goalTitle),
      JSON.stringify(finalBoard.trash.map((item) => `${item.kind}:${item.title}`)),
    );

    await evaluate(
      devtools,
      sessionId,
      `(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
      })()`,
      true,
    );

    /* ---- the log: writing a day through the room's own controls ---- */
    //
    // The room exists because health had no door: sleep, mood, meals and the
    // rest could only arrive from a phone or an export folder, so the briefing
    // read "sleep unrecorded" over a database that could hold the number. This
    // drives the controls the way a person does — type into the field, tap the
    // chip — and then reads the database back to see whether anything moved.
    //
    // It is careful about the live database it runs against: whatever today's
    // row held before is read first and put back at the end, whether that means
    // restoring a value or clearing one this check created.
    const healthBefore =
      caveExpected.health?.days?.find((day) => day.date === caveExpected.health.today) ?? null;

    await openCave();
    const logRoom = await enterRoom("Log");
    check("the Log room opens", /Log/.test(logRoom) && logRoom.length > 0, logRoom.slice(0, 80));
    check(
      "it shows a week of slots",
      (logRoom.match(/\b(?:mon|tue|wed|thu|fri|sat|sun|today)\b/gi) ?? []).length >= 7,
      logRoom.slice(0, 200),
    );
    check(
      "and the five readings the briefing complains about",
      // Case-insensitively: the row labels are uppercased by CSS, and
      // `innerText` reports what is rendered, not what is written.
      ["sleep", "energy", "mood", "meals", "steps", "exercise"].every((label) =>
        new RegExp(label, "i").test(logRoom),
      ),
      logRoom.slice(0, 200),
    );

    /** Type a number into a row and blur it, which is what commits it. */
    const typeInto = (ariaLabel, value) =>
      evaluate(
        devtools,
        sessionId,
        `(async () => {
          const panel = document.querySelector('[role="dialog"]');
          const input = panel?.querySelector('input[aria-label=${JSON.stringify(ariaLabel)}]');
          if (!input) return { found: false };
          // Focus first: the commit is on blur, and blur() on an element that
          // was never focused fires nothing at all — which is exactly how this
          // check reported a working field as broken the first time it ran.
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${JSON.stringify(String(value))});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 150));
          input.blur();
          await new Promise((r) => setTimeout(r, 1500));
          return { found: true, text: panel.innerText };
        })()`,
        true,
      );

    /** Tap a chip inside one of the room's labelled groups. */
    const tapChip = (group, label) =>
      evaluate(
        devtools,
        sessionId,
        `(async () => {
          const panel = document.querySelector('[role="dialog"]');
          const box = panel?.querySelector('[role="group"][aria-label=${JSON.stringify(group)}]');
          const button = box && [...box.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)});
          if (!button) return { found: false };
          button.click();
          await new Promise((r) => setTimeout(r, 1200));
          return { found: true, pressed: button.getAttribute('aria-pressed'), text: panel.innerText };
        })()`,
        true,
      );

    const readHealth = () =>
      fetch(`${base}/api/cave`, { cache: "no-store" })
        .then((r) => r.json())
        .then((payload) => payload.health?.days?.find((day) => day.date === payload.health.today) ?? null);

    const typed = await typeInto("Sleep in hours", 7.25);
    check("the sleep field is in the room", typed?.found === true);
    const afterSleep = await readHealth();
    check("typing 7.25 hours writes the day", afterSleep?.sleepHours === 7.3, `stored ${afterSleep?.sleepHours}`);
    check("and the week strip shows it", /7\.3h/.test(typed?.text ?? ""), (typed?.text ?? "").slice(0, 200));

    const moodTap = await tapChip("Mood", "good");
    check("the mood chips are in the room", moodTap?.found === true);
    check("tapping good marks it pressed", moodTap?.pressed === "true", String(moodTap?.pressed));
    check("and writes the mood", (await readHealth())?.mood === "good");

    const mealTap = await tapChip("Meals", "lunch");
    check("the meal chips are in the room", mealTap?.found === true);
    const afterMeal = await readHealth();
    check(
      "tapping lunch logs one meal, by name",
      afterMeal?.meals === 1 && afterMeal?.mealsLogged?.join() === "lunch",
      JSON.stringify(afterMeal),
    );
    check("and the room says which one", /1 of 3/.test(mealTap?.text ?? ""), (mealTap?.text ?? "").slice(0, 200));

    const shotLog = await screenshot(devtools, sessionId, "13-cave-log");
    console.log(`  info  ${shotLog}`);

    /** Click the "×" beside a reading. */
    const clearField = (what) =>
      evaluate(
        devtools,
        sessionId,
        `(async () => {
          const panel = document.querySelector('[role="dialog"]');
          const button = panel?.querySelector('button[aria-label=${JSON.stringify(`Clear ${what}`)}]');
          if (!button) return { found: false };
          button.click();
          await new Promise((r) => setTimeout(r, 1200));
          return { found: true, text: panel.innerText };
        })()`,
        true,
      );

    check("the sleep row offers a way to take it back", (await clearField("sleep for this day"))?.found === true);
    check("clearing removes just that reading", (await readHealth())?.sleepHours === undefined);
    check("the mood survives it", (await readHealth())?.mood === "good");

    // Put the day back exactly as it was found. Clearing everything this check
    // wrote is the difference between a check and an incident.
    await fetch(`${base}/api/cave`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "health.clear", field: "mood" }),
    });
    await fetch(`${base}/api/cave`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "health.clear", field: "meals" }),
    });
    if (healthBefore) {
      for (const [field, value] of [
        ["sleepHours", healthBefore.sleepHours],
        ["mood", healthBefore.mood],
        ["steps", healthBefore.steps],
        ["activeMinutes", healthBefore.activeMinutes],
        ["energy", healthBefore.energy],
      ]) {
        if (value === undefined) continue;
        await fetch(`${base}/api/cave`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op: "health.log", field, value }),
        });
      }
      if (healthBefore.mealsLogged?.length) {
        for (const meal of healthBefore.mealsLogged) {
          await fetch(`${base}/api/cave`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: "health.meal", meal, on: true }),
          });
        }
      }
    }
    const healthAfter = await readHealth();
    check(
      "today's row is left as it was found",
      JSON.stringify(healthAfter) === JSON.stringify(healthBefore),
      `before ${JSON.stringify(healthBefore)} after ${JSON.stringify(healthAfter)}`,
    );

    await evaluate(
      devtools,
      sessionId,
      `(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
      })()`,
      true,
    );

    /* ---------------- phone ---------------- */
    section("Phone · 390×844");

    await devtools.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      sessionId,
    );
    await devtools.send("Page.reload", {}, sessionId);
    await sleep(3000);

    const phone = await evaluate(
      devtools,
      sessionId,
      `(() => {
        const canvas = document.querySelector('.orb canvas');
        const rect = canvas?.getBoundingClientRect();
        return {
          width: window.innerWidth,
          overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
          orb: rect ? Math.round(rect.width) : 0,
          composerVisible: (() => {
            const f = document.querySelector('textarea');
            if (!f) return false;
            const r = f.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= window.innerHeight + 1;
          })(),
          // The settings entry point must remain reachable on a phone.
          settingsReachable: [...document.querySelectorAll('button')].some((b) => {
            if (!/settings/i.test(b.getAttribute('aria-label') || b.textContent || '')) return false;
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.right <= window.innerWidth + 1;
          }),
        };
      })()`,
    );

    check("the viewport is phone-width", phone?.width === 390, String(phone?.width));
    check("nothing overflows horizontally", phone?.overflowX === false);
    check("the orb renders", (phone?.orb ?? 0) > 100, `${phone?.orb}px`);
    check("the composer is on screen", phone?.composerVisible === true);
    check("settings is still reachable", phone?.settingsReachable === true);

    const shot5 = await screenshot(devtools, sessionId, "06-phone-idle");
    console.log(`  info  ${shot5}`);

    const phoneSettings = await evaluate(
      devtools,
      sessionId,
      `(async () => {
        const b = [...document.querySelectorAll('button')].find((x) => /settings/i.test(x.getAttribute('aria-label') || x.textContent || ''));
        b?.click();
        await new Promise((r) => setTimeout(r, 1200));
        const d = document.querySelector('[role="dialog"]');
        if (!d) return { open: false };
        const r = d.getBoundingClientRect();
        return { open: true, width: Math.round(r.width), height: Math.round(r.height) };
      })()`,
      true,
    );
    check("settings opens on a phone", phoneSettings?.open === true);
    check(
      "the panel fills the phone",
      (phoneSettings?.width ?? 0) >= 380,
      `${phoneSettings?.width}px of 390`,
    );
    const shot6 = await screenshot(devtools, sessionId, "07-phone-settings");
    console.log(`  info  ${shot6}`);

    /* ---------------- console ---------------- */
    section("The console");

    check(
      "no errors or warnings were logged",
      problems.length === 0,
      problems.slice(0, 5).join(" | "),
    );
    for (const problem of problems.slice(0, 8)) console.log(`  note  ${problem}`);
  } finally {
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
    child.kill();
  }

  section("Result");
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log(`  screenshots in ${OUT_DIR}\n`);
  if (fail > 0) process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* Connecting to the browser                                          */
/* ------------------------------------------------------------------ */

/**
 * The environment cannot host a browser. Not a failure of the app, so it is a
 * skip with a reason — and it has to *end* like one.
 *
 * Two things went wrong here before, both of which made a clean skip look like a
 * crash. The skip returned from `main()` while a half-spawned Chromium was still
 * alive, so Node tore down with a libuv assertion (`!(handle->flags &
 * UV_HANDLE_CLOSING)`) and a nonzero exit; and because it only exits when
 * `--yes` is passed, the report was ambiguous about whether the check had run.
 *
 * So: kill anything this script started, say plainly that nothing was verified,
 * and exit 0. A skip that exits nonzero is indistinguishable from a failure in
 * any CI that runs this, which is the opposite of the intent.
 */
function skipHostileEnvironment(child) {
  try {
    child?.kill();
  } catch {
    /* already gone */
  }
  console.log("\n  Skipped: this environment cannot host a browser.");
  console.log("  Chromium is a multi-process application built on named");
  console.log("  pipes, and both process creation and named pipes are denied");
  console.log("  here. Nothing about the app is at fault.");
  console.log("\n  On a normal machine this script launches headless Edge or");
  console.log("  Chrome, checks for console errors, drives the settings panel");
  console.log("  with real clicks, and writes screenshots to data/shots/.\n");
  console.log("  NOTHING WAS VERIFIED. Treat the orb, the hydration and the");
  console.log("  390px overflow claims as unverified until this passes once on");
  console.log("  a machine with a browser.\n");
  process.exitCode = 0;
}

async function connectWithRetry(attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      const info = await res.json();
      const socket = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("socket error")), {
          once: true,
        });
      });
      return socket;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`Could not reach the browser's DevTools endpoint on ${PORT}`);
}

main().catch((err) => {
  console.error(`\nBrowser verification failed: ${err.message}`);
  process.exitCode = 1;
});
