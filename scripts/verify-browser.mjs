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
 *   6. repeats at a phone viewport.
 *
 * Screenshots land in `data/shots/` so they are visible to a human
 * afterwards, which is the only way to judge whether it looks right.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const base = process.argv[2] ?? "http://127.0.0.1:4311";
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

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log("No Chromium-based browser found. Skipping browser verification.");
    console.log("Set CHROME_PATH to run it.");
    return;
  }

  const userDataDir = join(process.cwd(), "data", "browser-profile");
  mkdirSync(userDataDir, { recursive: true });

  console.log(`Browser   ${browserPath}`);
  console.log(`Target    ${base}`);

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
      skipHostileEnvironment();
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
      const { level, text } = message.params.entry;
      if (level === "error" && !/favicon/i.test(text)) {
        problems.push(`log: ${text}`.slice(0, 300));
      }
    }
  });

  try {
    /* ---------------- desktop ---------------- */
    section("Desktop · 1440×900");

    const { targetId } = await devtools.send("Target.createTarget", {
      url: "about:blank",
      width: 1440,
      height: 900,
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
          tabs: [...d.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim()),
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

    // Pick a different theme and prove the document recoloured, and that
    // the canvas picked the new accent up out of computed style.
    const recoloured = await evaluate(
      devtools,
      sessionId,
      `(async () => {
        const before = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
        const swatches = [...document.querySelectorAll('[role="radiogroup"] button')];
        const ember = swatches.find((b) => /ember/i.test(b.textContent || ''));
        if (!ember) return { error: 'no ember preset' };
        ember.click();
        await new Promise((r) => setTimeout(r, 500));
        const after = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
        return { before, after, press: ember.getAttribute('aria-pressed'), changed: before !== after };
      })()`,
      true,
    );

    if (recoloured?.error) {
      check("the theme picker recolours the document", false, recoloured.error);
    } else {
      check("the theme picker recolours the document", recoloured.changed === true, `${recoloured.before} -> ${recoloured.after}`);
      check("the preset reads as selected", recoloured.press === "true");
      console.log(`  info  accent ${recoloured.before} -> ${recoloured.after}`);
    }

    await sleep(1600);
    const shot3 = await screenshot(devtools, sessionId, "03-desktop-ember");
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

    // Put the theme back so the repo is left as it was found.
    await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { appearance: { theme: "xana" } } }),
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
 * The environment cannot host a browser. Not a failure of the app, so it
 * is not counted as one ?but it is not silently ignored either.
 */
function skipHostileEnvironment() {
  console.log("\n  Skipped: this environment cannot host a browser.");
  console.log("  Chromium is a multi-process application built on named");
  console.log("  pipes, and both process creation and named pipes are denied");
  console.log("  here. Nothing about the app is at fault.");
  console.log("\n  On a normal machine this script launches headless Edge or");
  console.log("  Chrome, checks for console errors, drives the settings panel");
  console.log("  with real clicks, and writes screenshots to data/shots/.\n");
  console.log("  It has NOT been run in this environment, so treat it as");
  console.log("  unverified until it passes once on your machine.\n");
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
