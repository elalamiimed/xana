/**
 * The mute button, driven in a real browser.
 *
 *   node scripts/verify-mute-browser.mjs [baseUrl]
 *
 * WHY THIS FILE EXISTS
 *
 * `verify:mute` proves the store, the rule and the wiring, all by reading
 * source and by round-tripping a settings file. None of that can see the two
 * things a user actually judges this control by:
 *
 *   1. **That pressing it stops her.** The interesting half of the mute is a
 *      race — a reply can land between the press and the re-render — and a race
 *      is not visible in a source reading. So the page's own `speechSynthesis`
 *      is replaced with a counting stub before any of the app loads, and the
 *      count is the assertion: muted, a reply is written and not spoken.
 *   2. **That the button is there, and is a button.** It is drawn after mount,
 *      because whether this browser can speak is not knowable during server
 *      render — so "is it in the HTML" is the wrong question and the served
 *      page genuinely does not contain it. It has to be asked of the live DOM.
 *
 * It also checks the tap floor at 390px, because a header control on a phone is
 * pressed by a thumb, and it puts the user's settings back exactly as it found
 * them — this runs against the owner's real settings file, not a fixture.
 *
 * A NOTE ON WHAT IS STUBBED, AND WHY THAT IS NOT CHEATING
 *
 * The stub replaces the *browser's* synthesiser, never anything of Xana's. The
 * app's own decision — whether to call `speak` at all — is the behaviour under
 * test and it runs untouched. Xana's `speak()` does the real `synth.cancel()`,
 * builds a real `SpeechSynthesisUtterance`, and calls the real `synth.speak`;
 * only the last of those lands on a counter instead of on the speakers, which is
 * also what keeps this from talking out loud on the machine running it.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const base = process.argv[2] ?? `http://127.0.0.1:${process.env.PORT ?? "4310"}`;
const OUT_DIR = join(process.cwd(), "data", "shots");
const PORT = 9223;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* A very small CDP client, as in verify-browser.mjs                   */
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
].filter(Boolean);

const findBrowser = () => CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;

class Devtools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const entry = message.id && this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
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
}

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

async function connectWithRetry(attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const info = await (
        await fetch(`http://127.0.0.1:${PORT}/json/version`, {
          signal: AbortSignal.timeout(1500),
        })
      ).json();
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

/* ------------------------------------------------------------------ */
/* The page helpers this file needs                                     */
/* ------------------------------------------------------------------ */

/** The header control, found by the label it carries in either state. */
const MUTE_BUTTON = `[...document.querySelectorAll('button')].find((b) => /^(mute|unmute) her voice/i.test(b.getAttribute('aria-label') || ''))`;

const buttonState = (devtools, sessionId) =>
  evaluate(
    devtools,
    sessionId,
    `(() => {
      const b = ${MUTE_BUTTON};
      if (!b) return { present: false };
      const r = b.getBoundingClientRect();
      return {
        present: true,
        // NOT truncated: this string is compared for equality, and a label cut
        // to 40 characters made the comparison fail on a correct button.
        label: b.getAttribute('aria-label') || '',
        title: b.getAttribute('title') || '',
        pressed: b.getAttribute('aria-pressed'),
        // The icon is the label, so its two paths are the state a sighted user
        // reads. Returned as data so "the glyph changed" is an assertion rather
        // than a claim about a screenshot.
        glyph: [...b.querySelectorAll('svg path')].map((p) => p.getAttribute('d')).join(' | '),
        height: Math.round(r.height),
        width: Math.round(r.width),
        onScreen: r.width > 0 && r.right <= window.innerWidth + 1 && r.left >= -1,
      };
    })()`,
  );

const clickMute = (devtools, sessionId) =>
  evaluate(
    devtools,
    sessionId,
    `(() => {
      const b = ${MUTE_BUTTON};
      if (!b) return false;
      b.click();
      return true;
    })()`,
  );

/** What the app stored, read from the route rather than from the page. */
const storedMuted = () =>
  fetch(`${base}/api/settings`, { cache: "no-store" })
    .then((res) => res.json())
    .then((payload) => payload.settings.voice.muted);

/**
 * Flip "Read replies aloud" through the panel's own switch and Save voice.
 *
 * The panel holds that switch in local state seeded when it opened, so it is
 * driven as a person drives it — click the switch, press Save — rather than by
 * writing the setting behind its back, which would leave the form disagreeing
 * with the store and prove nothing about either.
 */
const setPreference = (devtools, sessionId, on) =>
  evaluate(
    devtools,
    sessionId,
    `(async () => {
      const panel = document.querySelector('[role="tabpanel"]');
      if (!panel) return { panel: false };
      const speak = panel.querySelector('button[role="switch"][aria-label="Read replies aloud"]');
      if (!speak) return { panel: true, switch: false };
      if ((speak.getAttribute('aria-checked') === 'true') !== ${on ? "true" : "false"}) {
        speak.click();
        await new Promise((r) => setTimeout(r, 250));
      }
      const save = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save voice');
      save?.click();
      await new Promise((r) => setTimeout(r, 1200));
      return { panel: true, switch: true, save: Boolean(save), checked: speak.getAttribute('aria-checked') };
    })()`,
    true,
  );

/**
 * Send a turn through the composer, and wait for the reply to be finished.
 *
 * Two waits, and both are on something the app actually renders rather than on
 * a sleep. First the sentence that was typed has to appear in the transcript —
 * that is the turn being accepted. Then `.skeleton` has to be gone: the thinking
 * row is two drifting bars carrying that class, it is drawn while a reply is in
 * flight, and its absence is the reply having landed.
 *
 * This used to compare `document.body.innerText.length` before and after, which
 * was wrong for the first turn in a very specific way: an empty session shows
 * the briefing, and the briefing is longer than the two bubbles that replace it,
 * so the page got *shorter* as the reply arrived and the check reported a
 * working turn as a missing one. The length of the page is not a fact about the
 * conversation; the transcript is.
 */
async function sendTurn(devtools, sessionId, text) {
  const probe = text.split(/\s+/).pop();
  await evaluate(
    devtools,
    sessionId,
    `(async () => {
      const field = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(field, ${JSON.stringify(text)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`,
    true,
  );

  let accepted = false;
  for (let i = 0; i < 40 && !accepted; i += 1) {
    await sleep(300);
    accepted = await evaluate(
      devtools,
      sessionId,
      `document.body.innerText.includes(${JSON.stringify(probe)})`,
    );
  }
  if (!accepted) return { accepted: false, settled: false };

  // Wait for the thinking row to go, and to stay gone for two consecutive
  // reads: a reply that renders in pieces would otherwise be judged finished
  // at the first gap between them.
  let quiet = 0;
  for (let i = 0; i < 80 && quiet < 2; i += 1) {
    await sleep(300);
    const thinking = await evaluate(devtools, sessionId, `Boolean(document.querySelector('.skeleton'))`);
    quiet = thinking ? 0 : quiet + 1;
  }
  return { accepted: true, settled: quiet >= 2 };
}

/* ------------------------------------------------------------------ */

/**
 * Launch the browser, or say plainly why nothing was verified.
 *
 * Chromium is a multi-process application built on named pipes, and a sandbox
 * that denies process creation cannot host one — the failure arrives as an
 * EPERM from `spawn`, which reads like a defect in the app when it is a fact
 * about the environment. `verify-browser.mjs` treats that as a skip for the
 * same reason, and a skip that exits nonzero is indistinguishable from a
 * failure in anything that runs these in sequence.
 */
function spawnOrSkip(browserPath, userDataDir) {
  try {
    return spawn(
      browserPath,
      [
        "--headless=new",
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--window-size=1440,900",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"], detached: false },
    );
  } catch (err) {
    if (err?.code === "EPERM") {
      console.log("\n  Skipped: this environment denies process creation, so a");
      console.log("  browser cannot be launched here. Nothing about the app is");
      console.log("  at fault. Run `npm run verify:mute-browser` on a normal");
      console.log("  machine to drive the button for real.\n");
      console.log("  NOTHING WAS VERIFIED by this script. The store, the rule and");
      console.log("  the wiring are covered by `npm run verify:mute`, which needs");
      console.log("  no browser.\n");
      process.exitCode = 0;
      return null;
    }
    throw err;
  }
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log("No Chromium-based browser found. Skipping the browser check.");
    return;
  }

  // The server has to be Xana, and saying so here is what stops a wrong port
  // from reporting as a broken button. The timeout is generous because a dev
  // server recompiles the page on the first request after an edit, and a check
  // that gives up in four seconds reports that as "nothing is listening".
  try {
    const state = await (await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(20_000) })).json();
    if (typeof state?.partOfDay !== "string") throw new Error("something answered, but it is not Xana");
  } catch (err) {
    console.log(`\n  Cannot verify ${base} — ${err.message}. Start Xana first (npm run dev).\n`);
    return;
  }

  const before = await fetch(`${base}/api/settings`, { cache: "no-store" })
    .then((res) => res.json())
    .then((payload) => payload.settings.voice);

  /**
   * Put the machine into the state this check is about, and say so.
   *
   * It used to depend on the owner's own settings: the control only renders
   * when `speakReplies` is on, and the first assertion is that she speaks while
   * unmuted — so on a machine with spoken replies switched off, a working
   * feature was reported as a broken one. A check that needs a precondition has
   * to establish it. The original values are restored in the `finally` below,
   * whatever happens in between.
   */
  const setVoice = (voice) =>
    fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { voice } }),
    }).then((res) => res.json());

  await setVoice({ speakReplies: true, muted: false });

  const userDataDir = join(process.cwd(), "data", "browser-profile-mute");
  mkdirSync(userDataDir, { recursive: true });

  console.log(`Browser   ${browserPath}`);
  console.log(`Target    ${base}`);
  console.log(`Voice     found speakReplies=${before.speakReplies} muted=${before.muted}`);
  console.log(`          checking with speakReplies=true muted=false, restoring after\n`);

  const child = spawnOrSkip(browserPath, userDataDir);
  if (!child) return;

  let socket;
  try {
    socket = await connectWithRetry();
  } catch (err) {
    child.kill();
    console.log(`\n  Skipped: no browser answered (${err.message}).`);
    process.exitCode = 0;
    return;
  }

  const devtools = new Devtools(socket);
  /** Thrown errors, collected so cleanup still runs and the report names them. */
  const failures = [];

  try {
    const { targetId } = await devtools.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
    await devtools.send("Page.enable", {}, sessionId);
    await devtools.send("Runtime.enable", {}, sessionId);

    /**
     * Replace the browser's synthesiser BEFORE anything loads.
     *
     * `getter` is used rather than a plain assignment because
     * `window.speechSynthesis` is a readonly accessor on the Window prototype
     * and a stub written the obvious way throws in strict mode and silently
     * does nothing otherwise — leaving the count at zero forever and the check
     * passing for the wrong reason. That is the one way this file could lie.
     */
    const stub = await devtools.send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `(() => {
          const calls = { speak: 0, spoken: [], cancel: 0 };
          const stub = {
            getVoices: () => [],
            speak: (u) => { calls.speak += 1; calls.spoken.push(String(u && u.text || '').slice(0, 60)); },
            cancel: () => { calls.cancel += 1; },
            pause: () => {}, resume: () => {},
            addEventListener: () => {}, removeEventListener: () => {},
            speaking: false, pending: false, paused: false,
          };
          Object.defineProperty(window, 'speechSynthesis', { get: () => stub, configurable: true });
          window.__muteProbe = calls;
        })();`,
      },
      sessionId,
    );

    const loaded = new Promise((resolve) => {
      const onLoad = () => resolve();
      devtools.send("Page.navigate", { url: base }, sessionId).then(() => {
        setTimeout(onLoad, 4000);
      });
    });
    await loaded;
    // Hydration plus the first `/api/settings` read: the button appears only
    // once the shell knows the preference, which is the whole reason it cannot
    // be asserted against the served HTML.
    await sleep(2500);

    section("The button exists, in the live page");

    const found = await buttonState(devtools, sessionId);
    check("the header carries a mute control", found?.present === true, JSON.stringify(found));
    check(
      "it is named for a screen reader and for a hovering pointer",
      /^mute her voice/i.test(found?.label ?? "") && /mute her voice/i.test(found?.title ?? ""),
      `${found?.label} / ${found?.title}`,
    );
    check(
      "its name does not change with its state",
      found?.label === "Mute her voice. Replies are still written.",
      `${found?.label} — a toggle's label must be constant (W3C APG); aria-pressed carries the state`,
    );    check(
      "it reports its state to assistive tech",
      found?.pressed === "false",
      `aria-pressed=${found?.pressed}`,
    );
    check(
      "and draws a speaker rather than a crossed-out one",
      /^M2 5\.4/.test(found?.glyph ?? "") && !/M9\.8 5\.6/.test(found?.glyph ?? ""),
      found?.glyph,
    );
    check("it is inside the viewport", found?.onScreen === true);
    console.log(`  info  unmuted glyph — ${found?.glyph}`);

    section("Muting, and what the page stops doing");

    const probeBefore = await evaluate(devtools, sessionId, `window.__muteProbe.speak`);
    check("the synthesiser is stubbed, so nothing is spoken aloud here", probeBefore === 0, String(probeBefore));

    // First: prove the stub counts when she is allowed to talk. Without this
    // the "she stayed silent" assertion below would pass on a page where the
    // reply never arrived, in a browser where speech never worked, or with the
    // stub not installed at all.
    const spokeTurn = await sendTurn(devtools, sessionId, "say the word aurora");
    const afterAllowed = await evaluate(devtools, sessionId, `window.__muteProbe.speak`);
    check("a texted turn is accepted and answered", spokeTurn.accepted && spokeTurn.settled, JSON.stringify(spokeTurn));
    check(
      "and she reads it aloud while unmuted",
      afterAllowed >= 1,
      `${afterAllowed} speak() calls — if this is 0 the stub is not wired up and the mute checks below prove nothing`,
    );

    const muted = await clickMute(devtools, sessionId);
    check("the control can be pressed", muted === true);

    /**
     * The audio stops on the press; the button's own face waits for the PUT.
     *
     * Both are asserted where they are true rather than in one sentence that
     * would flatter the code. The glyph and `aria-pressed` come from the stored
     * value, so they arrive with the response — which is why the read below
     * happens after a short wait and is described as what it is. What must be
     * immediate is that she stops talking, and that is what the silence
     * assertions further down measure.
     */
    await sleep(900);

    const afterPress = await buttonState(devtools, sessionId);
    check("the control catches up with the stored state", afterPress?.pressed === "true", `aria-pressed=${afterPress?.pressed}`);
    check(
      "and the glyph changes with it, so the state is visible and not only announced",
      /M9\.8 5\.6 12\.6 8\.4/.test(afterPress?.glyph ?? "") && afterPress?.glyph !== found?.glyph,
      afterPress?.glyph,
    );
    check(
      "the label still offers the way back, without renaming itself",
      afterPress?.label === "Mute her voice. Replies are still written.",
      afterPress?.label,
    );
    check("the setting is on disk", (await storedMuted()) === true);

    /**
     * The mute must not leave the interface stuck mid-sentence.
     *
     * The header's word is worth reading carefully, because it is NOT a claim
     * that audio is playing. `useXana` holds a `speaking` presence for 2.6s
     * whenever a reply arrives — it is the ripple and the orb's settle, the same
     * beat whether she is read aloud or silent — and then hands the header back
     * to the poll. What would be a real defect is that beat never ending: an
     * override that outlives its timer leaves the orb claiming she is talking
     * for the rest of the session.
     *
     * Polled rather than read once because the point is that it *settles*, and
     * reading at one arbitrary instant is how a check like this reports a
     * working timer as a stuck one.
     */
    const presenceWords = () =>
      evaluate(
        devtools,
        sessionId,
        `(() => { const s = document.querySelector('header .timestamp'); return s ? s.textContent.trim() : null; })()`,
      );
    let settled = null;
    for (let i = 0; i < 20; i += 1) {
      await sleep(500);
      const word = await presenceWords();
      if (word && word !== "speaking") {
        settled = word;
        break;
      }
    }
    check(
      "the header hands the presence back after the reply, rather than staying on speaking",
      settled !== null,
      `still "${await presenceWords()}" after ten seconds`,
    );

    /**
     * The header, still quiet, photographed in the state this feature is about.
     *
     * Taken here rather than at the end of the section on purpose: the turns
     * below fill the page with a conversation, and a picture of a header should
     * be a picture of the interface she actually lives in.
     */
    const shot = await (async () => {
      const png = await devtools.send("Page.captureScreenshot", { format: "png" }, sessionId);
      mkdirSync(OUT_DIR, { recursive: true });
      const path = join(OUT_DIR, "18-header-muted.png");
      writeFileSync(path, Buffer.from(png.data, "base64"));
      return path;
    })();
    console.log(`  info  ${shot}`);

    const spokenBeforeMutedTurn = await evaluate(devtools, sessionId, `window.__muteProbe.speak`);
    const quietTurn = await sendTurn(devtools, sessionId, "say the word beacon");
    const spokenAfterMutedTurn = await evaluate(devtools, sessionId, `window.__muteProbe.speak`);
    check(
      "the reply to a texted message still arrives",
      quietTurn.accepted && quietTurn.settled,
      JSON.stringify(quietTurn),
    );
    check(
      "and is not spoken",
      spokenAfterMutedTurn === spokenBeforeMutedTurn,
      `${spokenBeforeMutedTurn} -> ${spokenAfterMutedTurn} speak() calls while muted`,
    );

    /**
     * The race, driven for real.
     *
     * The reply above lands some seconds after the press, so it is caught by the
     * ref. This presses Mute and sends in the same breath — which is the window a
     * state-only guard would lose — and requires the same silence.
     */
    await evaluate(
      devtools,
      sessionId,
      `(async () => {
        const b = ${MUTE_BUTTON};
        // Unmute first so the mute below is a real transition, then mute and
        // leave the composer's Enter to the same tick.
        if (b && b.getAttribute('aria-pressed') === 'true') { b.click(); await new Promise((r) => setTimeout(r, 700)); }
        const again = ${MUTE_BUTTON};
        again.click();
        const field = document.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(field, 'say the word cobalt');
        field.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      })()`,
      true,
    );
    const raceBefore = await evaluate(devtools, sessionId, `window.__muteProbe.speak`);
    await sleep(9000);
    const raceAfter = await evaluate(devtools, sessionId, `window.__muteProbe.speak`);
    check(
      "a reply that lands in the same breath as the press is silent too",
      raceAfter === raceBefore,
      `${raceBefore} -> ${raceAfter} speak() calls across the press`,
    );

    const conversationShot = await (async () => {
      const png = await devtools.send("Page.captureScreenshot", { format: "png" }, sessionId);
      mkdirSync(OUT_DIR, { recursive: true });
      const path = join(OUT_DIR, "18b-muted-with-conversation.png");
      writeFileSync(path, Buffer.from(png.data, "base64"));
      return path;
    })();
    console.log(`  info  ${conversationShot}`);

    section("The panel can say it, and undo it");

    const panel = await evaluate(
      devtools,
      sessionId,
      `(async () => {
        const settings = [...document.querySelectorAll('button')].find((b) => /^settings/i.test(b.getAttribute('aria-label') || ''));
        settings.click();
        await new Promise((r) => setTimeout(r, 1200));
        const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.trim() === 'Voice');
        tab.click();
        await new Promise((r) => setTimeout(r, 600));
        const body = document.querySelector('[role="tabpanel"]').innerText;
        const unmute = [...document.querySelectorAll('[role="tabpanel"] button')].find((b) => (b.textContent || '').trim() === 'Unmute now');
        return { open: Boolean(document.querySelector('[role="dialog"]')), saysMuted: /Muted — the sentence in progress was stopped/.test(body), unmute: Boolean(unmute), body: body.slice(0, 240) };
      })()`,
      true,
    );
    check("the Voice panel is open", panel?.open === true, JSON.stringify(panel).slice(0, 160));
    check("it says she is muted", panel?.saysMuted === true, panel?.body);
    check("and offers the way out", panel?.unmute === true);

    // Through the panel's own button, which is the second door into the state.
    const unmutedFromPanel = await evaluate(
      devtools,
      sessionId,
      `(async () => {
        const button = [...document.querySelectorAll('[role="tabpanel"] button')].find((b) => (b.textContent || '').trim() === 'Unmute now');
        button.click();
        await new Promise((r) => setTimeout(r, 1200));
        return document.querySelector('[role="tabpanel"]').innerText.includes('Muted — the sentence in progress was stopped');
      })()`,
      true,
    );
    check("unmuting from the panel clears it", unmutedFromPanel === false);
    check("and the store agrees", (await storedMuted()) === false);

    /**
     * The panel's Save must not lift the mute.
     *
     * This is the field bug a review found: the Voice panel always sends
     * `speakReplies`, so with a rule that read "speakReplies true and no muted
     * means unmute", changing the Speed slider silently unmuted her. Driven
     * here through the real form, because the store check alone cannot see what
     * the panel actually sends.
     */
    await clickMute(devtools, sessionId);
    await sleep(900);
    check("muted again for the save check", (await storedMuted()) === true, String(await storedMuted()));

    const savedFromPanel = await evaluate(
      devtools,
      sessionId,
      `(async () => {
        const panel = document.querySelector('[role="tabpanel"]');
        const label = [...panel.querySelectorAll('label')].find((l) => l.textContent.trim() === 'Speed');
        const input = label ? document.getElementById(label.htmlFor) : null;
        if (!input) return { found: false };
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '0.95');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        const save = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save voice');
        save?.click();
        await new Promise((r) => setTimeout(r, 1200));
        return { found: true, saved: Boolean(save) };
      })()`,
      true,
    );
    check("the speed slider and Save voice are reachable", savedFromPanel?.found && savedFromPanel?.saved, JSON.stringify(savedFromPanel));
    check(
      "saving the panel does not unmute her",
      (await storedMuted()) === true,
      "the panel's Save sends speakReplies, and it must not lift the mute",
    );

    const storedPreference = () =>
      fetch(`${base}/api/settings`, { cache: "no-store" })
        .then((res) => res.json())
        .then((payload) => payload.settings.voice.speakReplies);

    /**
     * The control belongs to the preference, in the header's own terms.
     *
     * A review found the guard drawing the button when the preference was OFF
     * and a stale mute was set — a pressed, accented speaker promising "she will
     * read replies aloud again" over an assistant that had been told not to. The
     * guard is `if (!speakReplies) return null` now, and this is what that looks
     * like to a person: switch the reading off and the header control goes with
     * it, switch it on and it comes back.
     */
    const switchedOff = await setPreference(devtools, sessionId, false);
    check("the Read replies aloud switch can be turned off", switchedOff?.checked === "false", JSON.stringify(switchedOff));
    check("and the preference is off on disk", (await storedPreference()) === false);
    check(
      "the header control goes with it, rather than describing a state that cannot happen",
      (await buttonState(devtools, sessionId))?.present === false,
      JSON.stringify(await buttonState(devtools, sessionId)),
    );
    check(
      "and the mute is cleared rather than left lying in the file",
      (await storedMuted()) === false,
      "a mute with the reading switched off is a trap for the next time it goes on",
    );

    const switchedOn = await setPreference(devtools, sessionId, true);
    check("the switch can be turned back on", switchedOn?.checked === "true", JSON.stringify(switchedOn));
    check("and the preference is on again", (await storedPreference()) === true);
    check(
      "the control comes back",
      (await buttonState(devtools, sessionId))?.present === true,
    );
    check(
      "and she is not left muted by the round trip",
      (await storedMuted()) === false,
    );

    // Put the speed back, and clear the mute for the sections below.
    await evaluate(
      devtools,
      sessionId,
      `(async () => {
        const panel = document.querySelector('[role="tabpanel"]');
        const label = [...panel.querySelectorAll('label')].find((l) => l.textContent.trim() === 'Speed');
        const input = label ? document.getElementById(label.htmlFor) : null;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '1');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save voice')?.click();
        await new Promise((r) => setTimeout(r, 1000));
        [...panel.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Unmute now')?.click();
        await new Promise((r) => setTimeout(r, 1000));
      })()`,
      true,
    );

    // Closing the panel, because the tap audit below measures the page.
    await evaluate(
      devtools,
      sessionId,
      `(async () => {
        for (const target of [document, document.body, window]) {
          target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 600));
      })()`,
      true,
    );

    section("The floor, at 390 wide");

    await devtools.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      sessionId,
    );
    await devtools.send("Page.reload", {}, sessionId);
    await sleep(3500);

    const phone = await buttonState(devtools, sessionId);
    check("the control survives a reload, like the setting it writes", phone?.present === true, JSON.stringify(phone));
    check(
      "it is a real touch target on a phone",
      (phone?.height ?? 0) >= 44,
      `${phone?.height}px tall, needs 44`,
    );
    check("and stays inside a 390px viewport", phone?.onScreen === true);

    const overflow = await evaluate(
      devtools,
      sessionId,
      `document.documentElement.scrollWidth > window.innerWidth + 1`,
    );
    check("the header does not overflow the phone", overflow === false);

    /**
     * Every control in the header has to be inside the viewport.
     *
     * This is the assertion the third button makes necessary rather than
     * optional. The header wraps a group at a time, and a group that is wider
     * than the phone does not wrap *within* itself — it runs off the edge, where
     * `overflow-x` stays clean because the header clips nothing, and a design
     * detector looking for horizontal scroll sees nothing wrong. The button that
     * leaves is the last one, which is Settings.
     *
     * Measured rather than eyeballed: 390px is 390px, and "the buttons look
     * cramped" is not a thing a script can act on. The geometry says the three
     * word-buttons end at 311px and the header is two rows tall, which is the
     * same shape DESIGN.md §6 describes for a narrow screen — the wordmark takes
     * a line, the controls take the next.
     */
    const headerBoxes = await evaluate(
      devtools,
      sessionId,
      `(() => {
        const header = document.querySelector('header');
        const controls = [...header.querySelectorAll('button')].map((b) => {
          const r = b.getBoundingClientRect();
          return { name: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 18), right: Math.round(r.right), width: Math.round(r.width) };
        });
        return {
          viewport: window.innerWidth,
          height: Math.round(header.getBoundingClientRect().height),
          controls,
          escaped: controls.filter((c) => c.right > window.innerWidth + 1).map((c) => c.name),
        };
      })()`,
    );
    check(
      "no header control is pushed off the edge",
      (headerBoxes?.escaped ?? ["?"]).length === 0,
      `${JSON.stringify(headerBoxes?.escaped)} in ${headerBoxes?.viewport}px`,
    );
    check(
      "and the mute button is among them",
      (headerBoxes?.controls ?? []).some((c) => /mute/i.test(c.name)),
      JSON.stringify(headerBoxes?.controls),
    );
    console.log(`  info  header ${headerBoxes?.height}px tall — ${headerBoxes?.controls.map((c) => `${c.name || "(icon only)"} ${c.width}px`).join(", ")}`);

    const phoneShot = await (async () => {
      const png = await devtools.send("Page.captureScreenshot", { format: "png" }, sessionId);
      const path = join(OUT_DIR, "19-phone-mute.png");
      writeFileSync(path, Buffer.from(png.data, "base64"));
      return path;
    })();
    console.log(`  info  ${phoneShot}`);

    await devtools.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: stub.identifier }, sessionId).catch(() => {});
  } catch (err) {
    /**
     * A throw must not be the end of the story.
     *
     * The settings restore used to sit after the `finally`, so any CDP timeout
     * or failed fetch skipped it — leaving the owner's real settings.json muted
     * by a check that had already gone wrong. The failure is recorded and the
     * cleanup below runs anyway.
     */
    failures.push(err instanceof Error ? err.message : String(err));
  } finally {
    try {
      socket?.close();
    } catch {
      /* already gone */
    }
    child.kill();

    /* Put the machine back exactly as it was found, whatever happened above. */
    await setVoice({ speakReplies: before.speakReplies, muted: before.muted }).catch(() => {});
  }

  const restored = await fetch(`${base}/api/settings`, { cache: "no-store" })
    .then((res) => res.json())
    .then((payload) => payload.settings.voice)
    .catch(() => null);
  section("Result");
  check(
    "the settings are left as they were found",
    restored?.speakReplies === before.speakReplies && restored?.muted === before.muted,
    JSON.stringify(restored),
  );
  if (failures.length > 0) {
    fail += failures.length;
    for (const message of failures) check("the run completed without throwing", false, message);
  }
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log(`  screenshots in ${OUT_DIR}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nMute verification failed: ${err.message}`);
  process.exitCode = 1;
});
