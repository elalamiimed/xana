/**
 * The local speech-to-text sidecar, checked.
 *
 *   node scripts/check-stt.mjs
 *
 * WHY THIS EXISTS
 *
 * The browser client is written against this service's HTTP contract, so the
 * contract is checked twice and in two different ways. The static pass reads
 * the source for the routes, the JSON keys, the defaults and the rules that are
 * decidable from text alone (no bare `except:`, no shell-out, an install
 * command in the not-ready reason). The runtime pass runs the service's own
 * `--selftest`, which starts a real server and asserts every promise — 200 for
 * a status check, 413 over the cap, 415 for audio it cannot read, CORS only for
 * loopback, an empty transcript rather than a 500.
 *
 * Neither of those would catch the thing most likely to break, which is the
 * wake-word matcher. `python/xana_stt.py` ports `src/components/xana/wake-word.ts`
 * by hand, and a port that drifts is a feature that works in the browser and
 * not in the sidecar. So this script also loads the TypeScript module itself,
 * runs a corpus through both implementations, and compares them case by case —
 * the answer is re-derived from the original every time rather than trusted to
 * a fixture table that could be stale.
 *
 * It never claims a check it did not run: no Python interpreter means SKIP, and
 * no TypeScript file means SKIP, both said in as many words.
 *
 * WHY THE CHILD PROCESSES WRITE TO FILES
 *
 * `spawnSync` with a piped stdio fails with EPERM under the DSH Windows
 * sandbox, because pipes are named pipes. Redirecting the child's output to a
 * file descriptor it owns uses no pipe and works in both cases, so every
 * subprocess here is captured that way.
 */

import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE_PATH = "python/xana_stt.py";
const WAKE_MODULE = "../src/components/xana/wake-word.ts";

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(label, detail = "") {
  passed += 1;
  console.log(`  ok    ${label}${detail ? ` - ${detail}` : ""}`);
}

function bad(label, detail = "") {
  failed += 1;
  console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
}

function skip(label, why) {
  skipped += 1;
  console.log(`  SKIP  ${label} - ${why}`);
}

function check(label, condition, detail = "") {
  if (condition) ok(label, detail);
  else bad(label, detail);
  return condition;
}

/* ------------------------------------------------------------------ */
/* Running a child process without a pipe                              */
/* ------------------------------------------------------------------ */

/**
 * Run a program, capture its output, return { status, error, output }.
 *
 * `stdio: ["ignore", fd, fd]` gives the child a real file rather than a pipe,
 * which is the difference between working and `spawnSync EPERM` in this
 * environment. ENOENT is reported back as `error.code` so a caller can tell
 * "not installed" (a skip) from "would not start" (a failure).
 */
function run(exe, args, options = {}) {
  const folder = mkdtempSync(join(tmpdir(), "xana-check-stt-"));
  const logPath = join(folder, "output.txt");
  const fd = openSync(logPath, "w");
  let result;
  try {
    result = spawnSync(exe, args, {
      cwd: options.cwd ?? process.cwd(),
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      timeout: options.timeoutMs ?? 180000,
    });
  } finally {
    closeSync(fd);
  }

  let output = "";
  try {
    output = readFileSync(logPath, "utf8");
  } catch {
    output = "";
  }
  rmSync(folder, { recursive: true, force: true });

  return { status: result.status, signal: result.signal, error: result.error, output };
}

/**
 * The interpreter, tried in the order the task and the README both promise:
 * `py -3`, then `python`, then `python3`.
 *
 * A non-zero exit is a candidate that does not work; only ENOENT means "no such
 * program". Anything else (EPERM from the sandbox, for instance) is returned so
 * the caller can fail honestly rather than pretend the interpreter is missing.
 */
function findInterpreter() {
  const candidates = [
    ["py", ["-3"]],
    ["python", []],
    ["python3", []],
  ];
  for (const [exe, prefix] of candidates) {
    const probe = run(exe, [...prefix, "--version"], { timeoutMs: 30000 });
    if (probe.status === 0) return { exe, prefix, version: probe.output.trim() };
    if (probe.error && probe.error.code !== "ENOENT") {
      return { exe, prefix, failure: `${probe.error.code ?? probe.error.message}` };
    }
  }
  return null;
}

/** Print a child's output indented, so a pass is visibly observed. */
function show(output, indent = "        ") {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  for (const line of lines) console.log(`${indent}${line}`);
}

/** The interesting lines of a child's output: its failures, notes and summary. */
function highlights(output) {
  return output
    .split("\n")
    .filter((line) => /FAIL|SKIP|note:|passed|PASS$/.test(line))
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* The parity corpus                                                   */
/* ------------------------------------------------------------------ */

/** Pull `DEFAULT_WAKE_PHRASES = (...)` out of the Python source. */
function pythonDefaultPhrases(text) {
  const match = text.match(/DEFAULT_WAKE_PHRASES[^=]*=\s*\(([^)]*)\)/);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]*)"/g)].map((found) => found[1]);
}

/**
 * The corpus, grouped so a failure says which kind of case broke.
 *
 * The cases are the ones in `scripts/check-wake-word.ts` - the canonical list -
 * because those are the sentences the feature is expected to survive, and the
 * negatives are the point of that file rather than its extras. They are run
 * through BOTH implementations here, so this is a comparison rather than a
 * second copy of the expectations.
 */
const PARITY_GROUPS = [
  {
    label: "the name alone",
    cases: ["Xana", "xana", "Xana!", "Xana?", "Zana", "Sana", "Xena", "exanna", "Xanna"],
  },
  {
    label: "a filler first, and the request after the name",
    cases: [
      "Hey Xana",
      "hey xana",
      "OK Xana",
      "okay, xana",
      "Hi Xana",
      "Yo Xana",
      "hello Xana",
      "Xana what's the weather",
      "Xana, what's the weather?",
      "hey Xana what's the weather",
      "OK Xana, add milk to my list",
      "Hey Zana, what is on my calendar",
      "Xana: how are the markets",
      "xana remind me to call mum",
      "hey hey xana what time is it",
      "um, Xana, are you there",
      "please xana tell me",
    ],
  },
  {
    label: "split or run together by a recogniser",
    cases: ["ex anna what's up", "hey zana what's the weather", "heyzana what's the weather", "okzana stop", "ex-anna play"],
  },
  {
    label: "near-misses that must match, and the line just past them",
    cases: ["Zara", "Sara", "Zena", "zanna", "Zara what's the weather", "cana", "Dana", "xanadu", "Xanax"],
  },
  {
    label: "the name inside a sentence must not wake her",
    cases: [
      "I told Xana to remind me",
      "I asked Xana about the weather yesterday",
      "does xana work offline",
      "the notes xana wrote are wrong",
      "what did xana say about the meeting",
      "I wish xana would stop interrupting",
      "so anyway xana said the markets were closed",
      "the xana is offline",
      "when xana is ready tell me",
      "if xana can do it",
      "I think xana should",
      "tell xana to stop",
      "what did zana say",
    ],
  },
  {
    label: "ordinary speech that merely sounds like the name",
    cases: [
      "can I ask you something",
      "can a person do that",
      "the banana is ripe",
      "anaconda is a long snake",
      "the analysis is done",
      "anyway I was saying",
      "in a minute",
      "a nana would know",
      "sonar is a kind of radar",
      "I need a nap",
      "hi story",
      "history",
      "hey story",
      "he zana stop",
    ],
  },
  {
    label: "stray words and punctuation",
    cases: ["a", "i", "an", "in", "on", "so", "the", "is", "ok", "hey", "", "   ", "...", " , . ", "12345", "a xana"],
  },
  {
    label: "the window is bounded",
    cases: ["word xana what is the weather", `${"word ".repeat(40)}xana what is the weather`],
  },
  {
    label: "encoding and other awkward shapes",
    cases: [
      "xana's",
      "Xana\u2019s reminder",
      "caf\u00e9 xana",
      "xana\u2026 are you there",
      "xana 2 pm remind me",
      "Xana, remind me Friday at 3",
      "xana xana hello",
      "\u00a0 xana \u00a0",
      "XANA STOP",
      "za na play music",
      "xen a play music",
    ],
  },
  {
    label: "configured phrase lists",
    cases: [
      ["Dana", ["dana"]],
      ["jarvis what's up", ["jarvis"]],
      ["xana hello", []],
      ["computadora enciende las luces", ["computadora"]],
      ["hey computadora, enciende las luces", ["computadora"]],
      ["xana play music", ["computadora"]],
      ["hey zana play music", ["xana", "zana"]],
      ["a play music", ["a"]],
      ["ex anna stop", ["exanna"]],
    ],
  },
];

/* ------------------------------------------------------------------ */
/* The source, and what can be decided by reading it                   */
/* ------------------------------------------------------------------ */

console.log("Local speech-to-text sidecar: python/xana_stt.py\n");

let source = "";
try {
  source = readFileSync(SOURCE_PATH, "utf8");
} catch (error) {
  bad(`${SOURCE_PATH} exists`, error instanceof Error ? error.message : String(error));
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(1);
}

ok(`${SOURCE_PATH} exists`, `${source.split("\n").length} lines`);
check(
  "it decodes as UTF-8, with no BOM",
  source.charCodeAt(0) !== 0xfeff && !source.includes("\uFFFD"),
  "a replacement character means a byte that was not valid UTF-8",
);

/* ---- the HTTP contract, as text ---------------------------------- */

const STATIC_CLAIMS = [
  {
    label: "declares the two routes the client calls",
    test: (s) => s.includes('HEALTH_PATH = "/health"') && s.includes('TRANSCRIBE_PATH = "/transcribe"'),
  },
  {
    label: "answers GET, POST and OPTIONS",
    test: (s) => ["def do_GET", "def do_POST", "def do_OPTIONS"].every((name) => s.includes(name)),
  },
  {
    label: "/health carries the seven contract keys",
    test: (s) =>
      ["ok", "service", "version", "backend", "model", "ready", "reason"].every((key) =>
        new RegExp(`"${key}"\\s*:`).test(s),
      ),
  },
  {
    label: "/transcribe carries text, language, durationMs, backend, model",
    test: (s) =>
      ["text", "language", "durationMs", "backend", "model"].every((key) => new RegExp(`"${key}"\\s*:`).test(s)),
  },
  { label: "refusals carry an error", test: (s) => /"error"\s*:/.test(s) },
  {
    label: "names the service and its version",
    test: (s) => s.includes('SERVICE = "xana-stt"') && s.includes('VERSION = "1"'),
  },
  {
    label: "defaults to loopback, port 4319, model base",
    test: (s) =>
      s.includes('DEFAULT_HOST = "127.0.0.1"') && s.includes("DEFAULT_PORT = 4319") && s.includes('DEFAULT_MODEL = "base"'),
  },
  {
    label: "offers auto, faster-whisper and whisper",
    test: (s) => s.includes('BACKENDS = ("auto", "faster-whisper", "whisper")'),
  },
  {
    label: "reads the documented environment variables",
    test: (s) =>
      ["XANA_STT_HOST", "XANA_STT_PORT", "XANA_STT_MODEL", "XANA_STT_BACKEND", "XANA_STT_MODEL_DIR"].every((name) =>
        s.includes(name),
      ),
  },
  { label: "caps a request body at 10 MB", test: (s) => s.includes("MAX_BODY_BYTES = 10 * 1024 * 1024") },
  {
    label: "reflects only a loopback Origin",
    test: (s) =>
      s.includes("LOOPBACK_ORIGIN") &&
      s.includes(String.raw`^http://(?:127\.0\.0\.1|localhost)`) &&
      s.includes("Access-Control-Allow-Origin"),
  },
  {
    label: "never downloads during a status check",
    test: (s) => s.includes("local_files_only") && s.includes("allow_download=False"),
  },
  {
    label: "names the install command when no backend is importable",
    test: (s) => s.includes("pip install faster-whisper") && s.includes("pip install openai-whisper"),
  },
  { label: "has no bare except", test: (s) => !/except\s*:/.test(s) },
  {
    label: "shells out to nothing",
    test: (s) => !/\bsubprocess\b|\bos\.system\b|\bos\.popen\b|\bpopen\s*\(/.test(s),
  },
  {
    label: "serialises model use behind a lock",
    test: (s) => s.includes("threading.Lock()") && s.includes("with self._model_lock"),
  },
  {
    label: "closes the socket it opened",
    test: (s) => s.includes("daemon_threads") && s.includes("server_close()"),
  },
  { label: "has a main guard", test: (s) => s.includes('if __name__ == "__main__"') },
  {
    label: "ports the wake matcher",
    test: (s) =>
      [
        "def normalize_transcript(",
        "def fold_token(",
        "def edit_distance(",
        "def tolerance_for(",
        "def is_wake_token(",
        "def match_wake(",
        "def strip_wake(",
      ].every((name) => s.includes(name)),
  },
];

for (const claim of STATIC_CLAIMS) {
  check(claim.label, claim.test(source));
}

/* ------------------------------------------------------------------ */
/* The service's own test, through the real interpreter                */
/* ------------------------------------------------------------------ */

const python = findInterpreter();

if (!python) {
  skip("python -m py_compile", "no py -3, python or python3 on PATH - nothing was compiled");
  skip("--selftest", "no Python interpreter - nothing was run");
  skip("--wake-selftest", "no Python interpreter - nothing was run");
} else if (python.failure) {
  bad(`could not start ${python.exe}`, python.failure);
} else {
  const label = `${python.exe} ${[...python.prefix].join(" ")}`.trim();

  const compiled = run(python.exe, [...python.prefix, "-m", "py_compile", SOURCE_PATH]);
  check(
    `${label} -m py_compile ${SOURCE_PATH}`,
    compiled.status === 0,
    compiled.status === 0 ? "exit 0" : `exit ${compiled.status}\n${compiled.output}`,
  );

  const selftest = run(python.exe, [...python.prefix, SOURCE_PATH, "--selftest"]);
  const selftestOk = check(
    `${label} ${SOURCE_PATH} --selftest`,
    selftest.status === 0,
    selftest.status === 0 ? "exit 0" : `exit ${selftest.status}`,
  );
  check(
    "--selftest reports no failing assertion",
    selftestOk && !/^\s*FAIL\b/m.test(selftest.output),
    "the captured output is below",
  );
  check(
    "--selftest printed a summary",
    /\d+ passed, \d+ failed/.test(selftest.output),
    "a run that produced no summary was not a run",
  );
  console.log("        --- captured ---");
  show(highlights(selftest.output));

  const wake = run(python.exe, [...python.prefix, SOURCE_PATH, "--wake-selftest"]);
  const wakeOk = check(
    `${label} ${SOURCE_PATH} --wake-selftest`,
    wake.status === 0,
    wake.status === 0 ? "exit 0" : `exit ${wake.status}`,
  );
  check(
    "--wake-selftest reports no failing assertion",
    wakeOk && !/^\s*FAIL\b/m.test(wake.output),
    "the captured output is below",
  );
  const wakeSummary = wake.output.match(/wake-selftest: (\d+) passed, (\d+) failed/);
  check("--wake-selftest printed a summary", wakeSummary !== null, wakeSummary ? wakeSummary[0] : "no summary line");
  if (wakeSummary) ok(`${wakeSummary[1]} fixture assertions ran against the port`, "");

  /* ---- parity with the TypeScript original ----------------------- */

  let wakeModule = null;
  try {
    wakeModule = await import(WAKE_MODULE);
  } catch (error) {
    skip("wake parity with the TypeScript matcher", `could not load ${WAKE_MODULE}: ${error}`);
  }

  if (wakeModule) {
    check(
      "the default phrase list is the same data in both files",
      JSON.stringify(pythonDefaultPhrases(source)) === JSON.stringify([...wakeModule.DEFAULT_WAKE_PHRASES]),
      `python ${JSON.stringify(pythonDefaultPhrases(source))} vs typescript ${JSON.stringify([...wakeModule.DEFAULT_WAKE_PHRASES])}`,
    );

    const folder = mkdtempSync(join(tmpdir(), "xana-wake-parity-"));
    const corpusPath = join(folder, "corpus.json");
    const answersPath = join(folder, "answers.json");
    const corpus = [];
    for (const group of PARITY_GROUPS) {
      for (const entry of group.cases) corpus.push(Array.isArray(entry) ? entry : [entry]);
    }

    let answers = null;
    try {
      writeFileSync(corpusPath, JSON.stringify(corpus), "utf8");
      const parity = run(python.exe, [...python.prefix, SOURCE_PATH, "--wake-parity", corpusPath, answersPath]);
      if (parity.status !== 0) {
        bad("the port answered the parity corpus", `exit ${parity.status}: ${parity.output.trim()}`);
      } else {
        answers = JSON.parse(readFileSync(answersPath, "utf8"));
      }
    } catch (error) {
      bad("the port answered the parity corpus", error instanceof Error ? error.message : String(error));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }

    check(
      "the port answered every case in the parity corpus",
      Array.isArray(answers) && answers.length === corpus.length,
      Array.isArray(answers) ? `${answers.length} of ${corpus.length}` : "no answers",
    );

    if (Array.isArray(answers) && answers.length === corpus.length) {
      let cursor = 0;
      for (const group of PARITY_GROUPS) {
        const divergences = [];
        for (const entry of group.cases) {
          const [text, phrases] = Array.isArray(entry) ? entry : [entry, undefined];
          const expected = wakeModule.matchWake(text, phrases ?? wakeModule.DEFAULT_WAKE_PHRASES);
          const actual = answers[cursor];
          cursor += 1;
          if (actual[0] !== expected.matched || actual[1] !== expected.command) {
            divergences.push(
              `${JSON.stringify(text)}: python ${actual[0]}/${JSON.stringify(actual[1])} ` +
                `vs typescript ${expected.matched}/${JSON.stringify(expected.command)}`,
            );
          }
        }
        check(
          `wake parity: ${group.label} (${group.cases.length} cases)`,
          divergences.length === 0,
          divergences.length ? `${divergences.length} disagree: ${divergences.slice(0, 3).join("; ")}` : "",
        );
      }
    }
  }
}

/* ------------------------------------------------------------------ */

console.log("");
if (failed > 0) {
  console.log(`  ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}\n`);
  console.log("  The sidecar no longer holds the contract the client was written against.\n");
  process.exit(1);
}
console.log(`  ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}\n`);
if (skipped > 0) {
  console.log("  Some checks did not run. NOTHING WAS VERIFIED for those.\n");
}
process.exit(0);

