/**
 * Does every source file still hold the characters it was written with?
 *
 *   node scripts/check-encoding.mjs
 *
 * This exists because the same mistake was made twice in this project, both
 * times by editing a file with PowerShell. `Get-Content` decodes a UTF-8 file
 * using the machine's ANSI codepage (CP936 here), and `Set-Content` writes the
 * result back as UTF-8. Every character outside ASCII survives the round trip
 * as a different character: an em dash becomes three CJK glyphs, the box-drawing
 * rules in the section headers become a row of them, and a BOM appears at the
 * top of the file.
 *
 * The result is not a crash. TypeScript still compiles, because the mangling
 * happens inside comments and string literals. What breaks is the interface:
 * a corrupted em dash inside a user-facing sentence ships a mojibake glyph to
 * the screen, and nothing in `typecheck`, `demo` or `verify:web` looks at a
 * character that is merely the wrong one.
 *
 * So this checks the only thing those suites cannot: that the bytes are the
 * ones that were intended.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = process.cwd();

/** Directories that are dependencies, generated output, or another project. */
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
  ".npm-cache",
  ".impeccable",
  ".impeccable-review",
  "data",
  // `python/setup.ps1` builds a virtual environment here. It is someone else's
  // source with its own encodings — 3057 "damaged locations" were reported from
  // inside it, all of them legitimate CJK in ModelScope's own fixtures. Scanning
  // dependencies for the project's own mistake is how a gate becomes noise, and
  // a gate nobody reads is worse than no gate. `models/` holds binary weights,
  // which are not in TEXT_EXTENSIONS and are skipped by extension anyway.
  ".venv",
  "venv",
  "models",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  ".cjs",
  ".css",
  ".json",
  ".md",
]);

/**
 * The shapes a bad round trip leaves behind.
 *
 * Built from character codes rather than written as literals: a literal
 * pattern matches itself, and this file would fail its own check. The
 * sequences are data, not prose, and assembling them says so.
 *
 *   A-tilde or A-circumflex followed by a continuation byte is where an
 *   accented letter and a curly apostrophe land once their bytes have been
 *   read as Windows-1252. That pairing does not occur in English prose.
 *
 *   An em dash needs only its first two decoded characters to be recognised.
 *   The third and fourth vary by decoder, and an earlier version that pinned
 *   them let a straight-quote dash through undetected.
 *
 * The examples are deliberately not written out here. They were, and the
 * guard failed on its own source.
 */
const ch = (code) => String.fromCharCode(code);
const CIRCUMFLEX = `${ch(0xc2)}${ch(0xc3)}`;
const CONTINUATION = `[${ch(0x80)}-${ch(0xbf)}]`;
const DASH_PREFIX = `${ch(0xe2)}${ch(0x20ac)}`;

const CORRUPTION = [
  { label: "mojibake (CJK from a codepage round trip)", test: /[\u3000-\u9fff\uff00-\uffef]/ },
  { label: "replacement character (lossy decode)", test: /\ufffd/ },
  {
    label: "mojibake (UTF-8 read as Latin-1)",
    test: new RegExp(`[${CIRCUMFLEX}]${CONTINUATION}|${DASH_PREFIX}`),
  },
];

/**
 * A line that says "this non-ASCII text is deliberate".
 *
 * The CJK rule is a heuristic, and like every heuristic it has a legitimate
 * counterexample: `docs/MIC-DIAGNOSIS.md` quotes the actual names of this
 * machine's audio endpoints, which Windows reports in Chinese. That is real
 * system output, and deleting it would delete the evidence the diagnosis rests
 * on — the exact trap `MEMORY.md` records for the heading rule.
 *
 * So the exemption is explicit, opt-in, and per line: a line carrying this
 * marker is skipped, which is auditable by reading the line, unlike a
 * whole-file exclusion or a loosened pattern. A mojibake line will not have
 * been marked by anyone.
 */
const DELIBERATE = "xana-encoding-ok";

const findings = [];
let scanned = 0;
let exempted = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full);
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extname(name))) continue;

    scanned += 1;
    const text = readFileSync(full, "utf8");
    const relative = full.slice(ROOT.length + 1);

    if (text.charCodeAt(0) === 0xfeff) {
      findings.push({ file: relative, line: 1, what: "BOM at the start of the file" });
    }

    // The line numbers are kept so a finding points at the line it found, and
    // the marker check runs per line rather than per file.
    const lines = text.split("\n");
    for (const { label, test } of CORRUPTION) {
      // Every occurrence is examined, not just the first: one exempted line must
      // not hide a genuine corruption further down the same file.
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!test.test(line)) continue;
        if (line.includes(DELIBERATE)) {
          exempted += 1;
          continue;
        }
        findings.push({
          file: relative,
          line: index + 1,
          what: label,
          // Captured from the line that actually matched. Reading it back after
          // the loop reported the LAST matching line instead of the triggering
          // one, which is the kind of small lie that makes a finding useless.
          around: line.trim().slice(0, 140),
        });
      }
    }
  }
}

walk(ROOT);

const note = exempted > 0 ? ` (${exempted} line(s) marked deliberate)` : "";

if (findings.length === 0) {
  console.log(`  ok    ${scanned} files, every character intact${note}`);
  process.exit(0);
}

console.log(`  FAIL  ${findings.length} damaged location(s) in ${scanned} files${note}\n`);
for (const finding of findings) {
  console.log(`    ${finding.file}:${finding.line}  ${finding.what}`);
  if (finding.around) console.log(`        ${finding.around}`);
}
console.log(
  "\n  Repair by restoring the file and reapplying the edit with a tool that\n" +
    "  reads and writes UTF-8 — not the shell's Get-Content/Set-Content.\n",
);
process.exit(1);
