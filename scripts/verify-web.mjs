/**
 * Verify the running app over real HTTP: the rendered page, the stylesheet
 * it links, and the API on the same origin.
 *
 *   node scripts/verify-web.mjs [baseUrl]
 *
 * The point of this file is that it is the only check that runs against
 * the *served* application rather than against modules in isolation. It
 * catches the class of failure a unit test cannot: a stylesheet that never
 * made it through the Tailwind pipeline, a route that 404s, a theme token
 * that is set on the server but not read by the canvas.
 */

const base = process.argv[2] ?? "http://127.0.0.1:4310";

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

async function main() {
  console.log(`Verifying ${base}`);

  /* ---------------- the page ---------------- */
  section("The page");

  const pageRes = await fetch(`${base}/`);
  const html = await pageRes.text();
  check("responds 200", pageRes.status === 200, String(pageRes.status));
  check("content-type is html", /text\/html/.test(pageRes.headers.get("content-type") ?? ""));
  check("renders a real document", html.length > 3000, `${html.length} bytes`);
  check('<html lang="en">', /<html lang="en"/.test(html));
  check("dark theme applied to <html>", /class="bg-void/.test(html));
  check("title names Xana", /<title>[^<]*Xana/.test(html));

  // The browser chrome colour is derived from the accent and must stay
  // dark, or a light-themed phone would render a bright address bar above
  // a near-black page. Checked by luminance rather than by literal value,
  // because it changes with the theme.
  const chrome = html.match(/name="theme-color"\s+content="(#[0-9a-f]{6})"/i)?.[1];
  check("theme-color is present", Boolean(chrome), chrome ?? "no meta tag matched");
  check(
    "theme-color is dark",
    (() => {
      if (!chrome) return false;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(chrome.slice(i, i + 2), 16) / 255);
      const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      return luminance < 0.1;
    })(),
    chrome,
  );

  check("stylesheet is linked", /globals_[a-z0-9]+\.css/.test(html));

  // The theme must be in the first byte of HTML, not applied by an effect.
  check(
    "accent channels are inlined on <html>",
    /--accent-rgb:\s*\d+\s+\d+\s+\d+/.test(html),
    "the theme would flash on load if this is missing",
  );
  check("ambient wash strength is inlined", /--ambient-glow:/.test(html));
  check("motion multiplier is inlined", /--motion:/.test(html));
  check("ambient wash element is rendered", /ambient-wash/.test(html));

  check("the orb is present", /class="orb state-/.test(html));
  check("orb exposes a status role", /role="status"/.test(html));
  check(
    "orb has a state label",
    /Xana is (dormant|listening|thinking|speaking|taking an action)/.test(html),
  );
  check("orb renders a canvas", /<canvas/.test(html));
  check(
    "orb canvas is hidden from assistive tech",
    /<canvas[^>]*aria-hidden="true"/.test(html),
  );
  check("composer is present", /<textarea/.test(html));
  check("the composer is labelled", /Ask Xana/.test(html));
  check(
    "settings entry point is in the header",
    /aria-label="Settings/.test(html) || /Settings<\/button>/.test(html),
  );

  /* ---------------- the stylesheet ---------------- */
  section("The stylesheet (as served, through Tailwind v4 + PostCSS)");

  const cssHref = html.match(/href="(\/_next\/static\/chunks\/[^"]+\.css)"/)?.[1];
  check("found the CSS asset", Boolean(cssHref), cssHref ?? "no href matched");
  if (cssHref) {
    const cssRes = await fetch(base + cssHref);
    const css = await cssRes.text();
    check("CSS responds 200", cssRes.status === 200, String(cssRes.status));
    console.log(`  info  ${css.length} bytes of CSS`);

    const expectations = [
      ["--void token", /--void:\s*#040406/i],
      ["accent channel triplet", /--accent-rgb:\s*\d+\s+\d+\s+\d+/],
      ["secondary accent triplet", /--accent-2-rgb:/],
      ["the accent alpha ramp", /--a-14:/],
      ["depth shadows", /--shadow-2:/],
      ["ambient gradient", /--ambient:/],
      [".label utility", /\.label\b/],
      [".body-text utility", /\.body-text/],
      [".card surface", /\.card\b/],
      [".floating surface", /\.floating/],
      [".field control", /\.field\b/],
      [".btn styles", /\.btn-primary/],
      [".switch styles", /\.switch-knob/],
      [".slider styles", /\.slider/],
      ["@keyframes breath", /@keyframes breath/],
      ["@keyframes ripple", /@keyframes ripple/],
      ["@keyframes spin-cw", /@keyframes spin-cw/],
      ["@keyframes sheet-in", /@keyframes sheet-in/],
      ["@keyframes shimmer", /@keyframes shimmer/],
      [".skeleton placeholder", /\.skeleton/],
      [".orb-halo layer", /\.orb-halo/],
      [".orb-core layer", /\.orb-core/],
      [".orb-ring layers", /\.orb-ring/],
      [".state-thinking rules", /\.state-thinking/],
      [".state-speaking rules", /\.state-speaking/],
      ["prefers-reduced-motion block", /prefers-reduced-motion/],
    ];
    for (const [label, re] of expectations) {
      check(label, re.test(css));
    }

    // The theme picker only works if the accent utilities resolve to the
    // *runtime* channel triplet rather than to a fixed colour.
    //
    // Note what is deliberately NOT asserted here: the presence of a
    // `@theme` block or of `--color-accent`. Tailwind's `@theme inline`
    // inlines the value into each utility instead of emitting the custom
    // property, so those never appear and asserting them tests an
    // implementation detail that is free to change. What matters is that
    // `--accent-rgb` reaches the document, because the orb's canvas reads
    // it back out of computed style, and that a utility consumes it.
    check(
      "the accent channel triplet reaches the document",
      /--accent-rgb:\s*\d+\s+\d+\s+\d+/.test(css),
    );
    check(
      "accent utilities resolve to the runtime triplet",
      /--accent-rgb\)/.test(css) && /\.bg-accent\b/.test(css),
      "utilities are not reading the live accent channels",
    );
    // The colours must not have been frozen to the default cyan at build
    // time; a hardcoded #6fe3e3 in a utility would defeat the theme picker.
    check(
      "no utility hardcodes the default accent colour",
      !/#6fe3e3/i.test(css),
      "a utility baked in the default accent instead of the live channels",
    );

    // STRAY-LITERAL CHECK. A few places genuinely cannot use `var()`: a
    // data URI inside a `background-image`, or an alpha-suffixed hex like
    // `#84879a24`. Those carry the value by hand, which makes them the ones
    // that rot silently when a token moves, and a grep for the token *name*
    // will never find them. The retired faint tone is pinned here because it
    // was hardcoded in exactly two such places and both survived a full
    // search-and-replace of the token.
    check(
      "no colour is left behind from the retired faint token",
      !/#6a6c7e/i.test(css),
      "a literal of the old --text-faint is still in the stylesheet",
    );

    /**
     * CONTRAST, COMPUTED FROM THE SERVED STYLESHEET.
     *
     * The floors were documented for a year and then quietly broken by a
     * change to an unrelated token: raising --surface-3 pushed --text-faint
     * from 4.54:1 to 4.21:1, under the 4.5 the file promises. Nothing
     * failed, because a comment cannot fail.
     *
     * The floor is a *relationship* between the text token and the surfaces
     * it lands on, so it has to be checked as one — reading both values out
     * of what the browser is actually served rather than out of the source.
     */
    const token = (name) => {
      const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css);
      return m ? m[1] : null;
    };
    const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const channel = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    const contrast = (a, b) => {
      const [hi, lo] = [luminance(toRgb(a)), luminance(toRgb(b))].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const surfaces = ["void", "surface", "surface-2", "surface-3"].map((n) => [n, token(n)]);
    for (const [name, floor] of [
      ["text", 4.5],
      ["text-dim", 4.5],
      ["text-faint", 4.5],
    ]) {
      const colour = token(name);
      if (!colour) {
        check(`--${name} is defined`, false, "no hex value in the served CSS");
        continue;
      }
      const worst = surfaces
        .filter(([, hex]) => hex)
        .map(([sn, hex]) => ({ sn, ratio: contrast(colour, hex) }))
        .sort((a, b) => a.ratio - b.ratio)[0];
      check(
        `--${name} clears ${floor}:1 on every surface`,
        worst.ratio >= floor,
        `worst is ${worst.ratio.toFixed(2)}:1 on --${worst.sn} (needs ${floor})`,
      );
    }

    // The ladder, not just the tokens. These steps being invisible is what
    // made nested panels look flat, so the spacing is asserted rather than
    // trusted to a comment.
    const surfacePairs = [["void", "surface"], ["surface", "surface-2"], ["surface-2", "surface-3"]];
    for (const [a, b] of surfacePairs) {
      const [ha, hb] = [token(a), token(b)];
      if (!ha || !hb) continue;
      const step = contrast(ha, hb);
      check(
        `--${b} is a visible step above --${a}`,
        step >= 1.08,
        `${step.toFixed(2)}:1 between them`,
      );
    }
    for (const name of ["hairline", "hairline-2"]) {
      const colour = token(name);
      if (!colour) continue;
      const step = contrast(colour, token("surface"));
      check(
        `--${name} is visible on a surface`,
        step >= 1.3,
        `${step.toFixed(2)}:1 against --surface`,
      );
    }

    // A DEAD-CLASS CHECK, which is the one thing neither `tsc` nor any amount
    // of module testing can catch: a class string is just text, so a renamed
    // token leaves `bg-cyan` in a component that no longer compiles to
    // anything. The element keeps its layout and silently loses its colour.
    // The trailing `(?![0-9-])` matters: `border-cyan-400` is a *stock*
    // Tailwind palette entry and a different problem, checked separately
    // below, and without the lookahead this test reports it as a false hit.
    check(
      "no component still refers to the retired cyan/violet tokens",
      !/\.(?:bg|text|border|from|to|via)-(?:cyan|violet)(?![0-9-])/.test(css),
      "a renamed token is still referenced somewhere",
    );

    // POLLUTION CHECK. Tailwind v4 scans the project by default, and Xana
    // vendors the Impeccable skill clone at `.impeccable/` for its reference
    // docs. That clone is a monorepo whose test fixtures contain Tailwind
    // class names, and scanning them added ~28 KB of stylesheet for classes
    // this app never uses. `globals.css` pins the source with `@source
    // "../../src"`, and this asserts that pin still holds. Without it the
    // regression is invisible: the app looks identical and merely ships
    // someone else's demo styles.
    check(
      "the vendored clone's styles are not compiled into the app",
      !/\.(?:border|bg|text)-(?:cyan|blue|emerald|rose|amber|slate)-\d{3}/.test(css),
      "Tailwind is scanning .impeccable/ again — check the @source directive",
    );
  }

  /* ---------------- the API on the same origin ---------------- */
  section("The API on the same origin");

  const stateRes = await fetch(`${base}/api/state`);
  const state = await stateRes.json();
  check("/api/state responds 200", stateRes.status === 200, String(stateRes.status));
  check("/api/state has presence", typeof state.presence === "string", state.presence);
  check("/api/state has a headline", typeof state.headline === "string");
  check(
    "/api/state reports an engine",
    state.engine === "llm" || state.engine === "local",
    state.engine,
  );

  // One status row per registered connection, including the ones that are
  // switched off — a row per connection means the UI can never lose one. The
  // expected count comes from the connections endpoint rather than a literal, so
  // adding a connection cannot make this check stale, and the two surfaces
  // disagreeing about how many connections exist is itself the failure worth
  // catching.
  const connectionCount = (await (await fetch(`${base}/api/connections`)).json()).plugins?.length;

  for (const path of ["/api/context", "/xana/context"]) {
    const res = await fetch(base + path);
    const body = await res.json();
    const ls = body.lifeState;
    check(`${path} responds 200`, res.status === 200, String(res.status));
    check(`${path} returns a life state`, Boolean(ls));
    if (ls) {
      check(
        `${path} reports one row per connection`,
        ls.sources?.length === connectionCount,
        `${ls.sources?.length} rows for ${connectionCount} connections`,
      );
    }
  }

  const ls = (await (await fetch(`${base}/xana/context`)).json()).lifeState;
  console.log(`\n  headline    ${ls.headline}`);
  console.log(`  energy      ${ls.energy.score}/100 (${ls.energy.band})`);
  console.log(`  calendar    ${ls.calendar.today.length} today, ${ls.calendar.freeMinutes}m free`);
  console.log(`  tasks       ${ls.tasks.openCount} open, ${ls.tasks.focus.length} triaged, ${ls.tasks.overdue.length} overdue`);
  console.log(`  habits      ${ls.habits.length}`);
  console.log(`  goals       ${ls.goals.length}`);
  console.log(`  patterns    ${ls.patterns.length}`);
  console.log(`  nudges      ${ls.nudges.length}`);
  console.log(`  memory      ${ls.memory.length} recalled`);
  console.log(`  sources     ${ls.sources.map((s) => `${s.label}:${s.state}`).join(", ")}`);

  /* ---------------- settings ---------------- */
  section("Settings");

  const settingsRes = await fetch(`${base}/api/settings`);
  const settingsBody = await settingsRes.json();
  const settings = settingsBody.settings;
  check("/api/settings responds 200", settingsRes.status === 200, String(settingsRes.status));
  check("returns a settings view", Boolean(settings));
  check("exposes the appearance", Boolean(settings?.appearance?.accent));
  check("exposes the effective model", Boolean(settings?.effective));
  check("reports whether a model is active", typeof settings?.effective?.active === "boolean");

  // The gateway namespace must serve the same thing, or a future client
  // picking the documented prefix would get a 404.
  const canonical = await fetch(`${base}/xana/settings`);
  const canonicalBody = await canonical.json();
  check("/xana/settings responds 200", canonical.status === 200, String(canonical.status));
  check(
    "both prefixes return the same shape",
    JSON.stringify(Object.keys(canonicalBody.settings ?? {}).sort()) ===
      JSON.stringify(Object.keys(settings ?? {}).sort()),
  );
  check(
    "the API key is a mask, never a value",
    typeof settings?.model?.apiKey?.masked === "string" &&
      !("value" in (settings?.model?.apiKey ?? {})),
  );
  check(
    "the mask is bulleted rather than a real key",
    !settings?.model?.apiKey?.present || settings.model.apiKey.masked.startsWith("•"),
    settings?.model?.apiKey?.masked,
  );
  check("reports where settings are stored", typeof settings?.settingsPath === "string");
  check(
    "settings live alongside the database",
    /data[\\/]settings\.json$/.test(settings?.settingsPath ?? ""),
    settings?.settingsPath,
  );
  console.log(`  theme       ${settings?.appearance?.theme} · rgb(${settings?.appearance?.accent})`);
  console.log(`  motion      ×${settings?.appearance?.motionSpeed}`);
  console.log(`  model       ${settings?.effective?.active ? settings.effective.model : "local mind"}`);
  console.log(`  file        ${settings?.settingsPath}`);

  // A round trip: change the theme, prove the server renders it on the next
  // load, then change it back. This is the one check that exercises the whole
  // path — write, persist, re-read, re-render — rather than just its shape.
  const original = settings?.appearance?.theme ?? "xana";
  const target = original === "ember" ? "moss" : "ember";

  const writeRes = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { appearance: { theme: target } } }),
  });
  const written = await writeRes.json();
  check("PUT /api/settings accepts a theme change", writeRes.status === 200, String(writeRes.status));
  check(
    "the change is reflected in the response",
    written?.settings?.appearance?.theme === target,
    written?.settings?.appearance?.theme,
  );

  const reRendered = await (await fetch(`${base}/`)).text();
  const writtenChannels = written?.settings?.appearance?.accent;
  check(
    "the new theme reaches the next page load",
    Boolean(writtenChannels) && reRendered.includes(`--accent-rgb:${writtenChannels}`),
    `expected --accent-rgb:${writtenChannels}`,
  );

  const restore = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { appearance: { theme: original } } }),
  });
  check("the original theme is restored", restore.status === 200, String(restore.status));

  /* ---------------- chat over HTTP ---------------- */
  section("A turn over HTTP");

  const chatRes = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "what's my day look like", sessionId: "verify" }),
  });
  const chat = await chatRes.json();
  check("/api/chat responds 200", chatRes.status === 200, String(chatRes.status));
  check("returns a message", Boolean(chat.message?.text));
  check("returns a refreshed life state", Boolean(chat.lifeState));
  console.log(`  you  │ what's my day look like`);
  console.log(`  xana │ ${chat.message?.text}`);
  console.log(`       │ cards: ${(chat.message?.cards ?? []).map((c) => c.kind).join(", ") || "none"}`);

  /* ---------------- result ---------------- */
  section("Result");
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log(`  (the orb's 3D maths is checked separately: npm run verify:orb)\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nVerification failed: ${err.message}`);
  process.exitCode = 1;
});
