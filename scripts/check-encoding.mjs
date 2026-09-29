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
 * CJK ranges are the tell for a CP936 round trip, U+FFFD for a lossy decode.
 *
 * Xana's own copy is English, so any CJK character in the tree is either a
 * corruption or a deliberate translation — and there is no translation, which
 * is exactly why this can be a hard failure rather than a warning.
 */
const CORRUPTION = [
  { label: "mojibake (CJK from a codepage round trip)", test: /[\u3000-\u9fff\uff00-\uffef]/ },
  { label: "replacement character (lossy decode)", test: /\ufffd/ },
];

const findings = [];
let scanned = 0;

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
    for (const { label, test } of CORRUPTION) {
      const match = test.exec(text);
      if (!match) continue;
      const line = text.slice(0, match.index).split("\n").length;
      const around = text
        .slice(Math.max(0, match.index - 30), match.index + 30)
        .replace(/\n/g, "\\n");
      findings.push({ file: relative, line, what: label, around });
    }
  }
}

walk(ROOT);

if (findings.length === 0) {
  console.log(`  ok    ${scanned} files, every character intact`);
  process.exit(0);
}

console.log(`  FAIL  ${findings.length} damaged location(s) in ${scanned} files\n`);
for (const finding of findings) {
  console.log(`    ${finding.file}:${finding.line}  ${finding.what}`);
  if (finding.around) console.log(`        ...${finding.around}...`);
}
console.log(
  "\n  Repair by restoring the file and reapplying the edit with a tool that\n" +
    "  reads and writes UTF-8 — not the shell's Get-Content/Set-Content.\n",
);
process.exit(1);
