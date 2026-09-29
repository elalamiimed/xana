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
