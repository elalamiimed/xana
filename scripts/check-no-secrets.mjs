/**
 * Would publishing this repository publish something private?
 *
 *   node scripts/check-no-secrets.mjs
 *
 * Xana holds a life: a SQLite store, a settings file with API keys in
 * plaintext, a token the phone authenticates with. None of that is in the
 * repository, and the reason it is not is `.gitignore` — which is a text file
 * that one careless edit, or one `git add -f`, stops doing its job. When that
 * happens nothing warns you. The first symptom is a public commit.
 *
 * So this is the tripwire on the far side of that gate. It reads the files a
 * clone would receive and looks for three things:
 *
 *   1. The shapes credentials actually have — provider prefixes, private key
 *      blocks, JWTs.
 *   2. The literal values from this machine's own private files: `.env` and
 *      `data/settings.json`. This is the rule that does not need to know the
 *      *shape* a key has — only that someone pasted one somewhere — which is
 *      what makes it the useful one. A key that reaches a doc by accident is
 *      caught by value, not by pattern.
 *   3. A Windows home directory that is not a placeholder — the way a path
 *      copied out of a terminal ends up committed.
 *
 * It then checks the ignore rules still name `data/` and `.env`, because every
 * rule above is defeated by publishing those two, and a pattern check cannot
 * see a missing line.
 *
 * Two things this deliberately is not. It is not a proof of absence: it knows
 * the shapes it was taught and the values on the machine it runs on, and a
 * secret of a shape it does not know, from a machine whose `.env` it cannot
 * read, passes. GitHub's own secret scanning is the backstop for that, and it
 * is on by default for public repositories. And it is not a gate on the past:
 * it reads the working tree, so a secret that was committed and then deleted
 * is invisible here and permanent in the history. `git log -p` is the only
 * thing that answers that question.
 *
 * Like `check-encoding.mjs`, this must not fail on its own source, so every
 * pattern below puts a character class immediately after its literal prefix.
 * The literal text in this file is `sk-[A-Za-z0-9]`, and that does not match
 * the pattern `sk-` followed by alphanumerics, because `[` is not one.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = process.cwd();

/**
 * Directories that are dependencies, generated output, private state, or
 * another project.
 *
 * This list has to stay in step with `.gitignore`, and the direction that
 * matters is this one: a directory skipped here is not scanned, so it is only
 * safe to skip what Git also refuses to publish. Adding a directory to this
 * list is therefore a decision about privacy, not about speed. The check of
 * the ignore rules at the end is what keeps the two lists honest about the
 * cases that would be catastrophic.
 */
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
  ".npm-cache",
  ".impeccable",
  ".impeccable-cache",
  ".impeccable-review",
  ".claude",
  ".dsh",
  ".vscode",
  ".idea",
  "data",
  ".venv",
  "venv",
  "models",
]);

/** Extensions worth reading as text. Anything else is binary or generated. */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  ".cjs",
  ".css",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".html",
  ".ps1",
  ".py",
  ".txt",
  ".example",
]);

/**
 * Files with no extension that are still text.
 *
 * `extname("LICENSE")` is `""` and `extname(".gitignore")` is `""` too — a
 * leading dot is not an extension — so a walk keyed on extensions alone would
 * skip the very files most likely to be read by a person, and by a scanner
 * pretending to be one.
 */
const NO_EXTENSION = new Set([
  "LICENSE",
  "NOTICE",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
]);

/**
 * Private files on this machine, used as a source of literal values.
 *
 * `.env.example` is excluded by name: it is the published template, and the
 * whole point of it is that it holds the variable names with empty values.
 */
const PRIVATE_FILES = [".env", ".env.local", ".env.development", ".env.production", "data/settings.json"];

/** A name that is `.env` or a `.env` variant, but not the example. */
const isPrivateName = (name) => /^\.env(\.|$)/.test(name) && name !== ".env.example";

/**
 * The shapes.
 *
 * Each pattern is paired with what it means, because a finding that says
 * "AKIA…" to someone who has never seen an AWS key id has told them nothing
 * about what to do next.
 */
const SHAPES = [
  { label: "AWS access key id", test: /AKIA[0-9A-Z]{16}/ },
  { label: "GitHub token", test: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { label: "GitHub fine-grained token", test: /\bgithub_pat_[A-Za-z0-9_]{60,}/ },
  { label: "OpenAI-shaped API key", test: /\bsk-[A-Za-z0-9_-]{32,}/ },
  { label: "Anthropic API key", test: /\bsk-ant-[A-Za-z0-9_-]{32,}/ },
  { label: "Slack token", test: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: "Google API key", test: /AIza[0-9A-Za-z_-]{35}/ },
  { label: "npm token", test: /\bnpm_[A-Za-z0-9]{36}/ },
  { label: "Hugging Face token", test: /\bhf_[A-Za-z0-9]{30,}/ },
  { label: "Stripe secret key", test: /\bsk_live_[A-Za-z0-9]{24,}/ },
  { label: "private key block", test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "JSON Web Token", test: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
];

/**
 * A home directory segment that is a stand-in rather than a person.
 *
 * `src/lib/settings/types.ts` documents a folder field with
 * `C:\Users\you\Documents\Vault`, and that is correct documentation. What is
 * not correct is the segment being a real account name, which is how a machine
 * ends up identified in a public repository.
 */
const PLACEHOLDER_USERS = new Set([
  "you",
  "your",
  "user",
  "username",
  "yourname",
  "your-name",
  "name",
  "me",
  "someone",
  "example",
  "test",
  "%username%",
  "<user>",
  "{user}",
]);

const WINDOWS_HOME = /[A-Za-z]:\\{1,2}Users\\{1,2}([A-Za-z0-9._%-]+)/g;

/**
 * A line that says "the credential-shaped text here is deliberate".
 *
 * `scripts/verify-providers.mjs` tests a redaction function by handing it an
 * obviously fake key. A guard that fails on the test of another guard teaches
 * people to add exclusions, so the marker makes the intent auditable by
 * reading the line: a real key will not have been marked by anyone.
 */
const DELIBERATE = "xana-secret-ok";

const findings = [];
let scanned = 0;

/**
 * The names that mean "this field holds a credential".
 *
 * The first version of this harvested *every* value out of `.env`, and it
 * failed on its own repository. `.env` also holds `deepseek-chat` and
 * `https://api.deepseek.com/v1` — public defaults that appear legitimately in
 * forty places — so the guard reported forty-seven leaks and none of them were
 * leaks. A guard that cries wolf is a guard people switch off, which is worse
 * than not having one, so a field has to look like a credential before its
 * value is treated as one.
 */
const CREDENTIAL_NAME = /(key|token|secret|password|passphrase|credential|auth|bearer|signature)/i;

/**
 * A value that was generated rather than chosen.
 *
 * This is the half that does not depend on a field being named well — a key
 * pasted into `identity.name` is still a key. Length alone is not enough (a
 * long sentence is long), so it asks for a long, unbroken, mixed string: no
 * whitespace, not a URL, more than one kind of character, and enough distinct
 * characters that it is not a word repeated.
 */
function looksGenerated(value) {
  if (value.length < 32) return false;
  if (/\s/.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((test) => test.test(value)).length;
  return kinds >= 2 && new Set(value).size >= 12;
}

/**
 * Whether a value is worth checking every published file against.
 *
 * The name is returned with it so the report can say *which* private field
 * leaked. The name is safe to print; the value is not, and is never printed.
 */
function candidate(name, value, source) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) return null;
  if (CREDENTIAL_NAME.test(name) && text.length >= 8) return { name, source, value: text };
  if (looksGenerated(text)) return { name: `${source} → ${name || "a value"}`, source, value: text };
  return null;
}

/** The literal values from this machine that must not appear in any file. */
function privateValues() {
  const values = [];
  for (const relative of PRIVATE_FILES) {
    const full = join(ROOT, relative);
    if (!existsSync(full)) continue;
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }

    if (relative.endsWith(".json")) {
      // Every string in the settings file is offered as a candidate: the name
      // it sits under decides whether that name alone makes it a credential,
      // and `looksGenerated` catches the rest. The key path is carried down so
      // a nested `plugins.crypto.apiKey` reports as exactly that.
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        findings.push({
          file: relative,
          line: 1,
          what: "settings file is not valid JSON, so its values could not be checked",
        });
        continue;
      }
      const walk = (node, path) => {
        if (typeof node === "string") {
          const found = candidate(path, node, relative);
          if (found) values.push(found);
          return;
        }
        if (Array.isArray(node)) {
          for (const item of node) walk(item, path);
          return;
        }
        if (node && typeof node === "object") {
          for (const [key, item] of Object.entries(node)) walk(item, path ? `${path}.${key}` : key);
        }
      };
      walk(parsed, "");
      continue;
    }

    for (const line of text.split("\n")) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
      if (!match) continue;
      const found = candidate(match[1], match[2].replace(/^["']|["']$/g, ""), relative);
      if (found) values.push(found);
    }
  }

  // Two fields can hold the same key; checking it twice would report the same
  // leak twice.
  const seen = new Set();
  return values.filter((entry) => (seen.has(entry.value) ? false : seen.add(entry.value)));
}

const VALUES = privateValues();

function examine(relative, text) {
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.includes(DELIBERATE)) continue;

    for (const { label, test } of SHAPES) {
      // The match is replaced before the line is printed, not the whole line.
      // The first version of this printed the surrounding text verbatim and so
      // put the credential itself into the report — into a terminal, into this
      // session's transcript, and into a CI log. A report of a leak is not a
      // second copy of the leak; the `around` field exists to show *where*,
      // and the file and line already say where.
      const found = test.exec(line);
      if (!found) continue;
      findings.push({
        file: relative,
        line: index + 1,
        what: label,
        around: line.trim().replace(found[0], "…").slice(0, 140),
      });
    }

    for (const entry of VALUES) {
      if (line.includes(entry.value)) {
        findings.push({
          file: relative,
          line: index + 1,
          what: `the value of ${entry.name} (${entry.value.length} characters)`,
          // The value itself is not printed. A report of a leak is not a
          // second copy of the leak, and this output goes into CI logs.
          around: line.trim().replace(entry.value, "…").slice(0, 140),
        });
      }
    }

    WINDOWS_HOME.lastIndex = 0;
    let home;
    while ((home = WINDOWS_HOME.exec(line)) !== null) {
      if (PLACEHOLDER_USERS.has(home[1].toLowerCase())) continue;
      findings.push({
        file: relative,
        line: index + 1,
        what: `a real Windows home directory ("${home[1]}") rather than a placeholder`,
        around: line.trim().slice(0, 140),
      });
    }
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    if (isPrivateName(name)) continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full);
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extname(name)) && !NO_EXTENSION.has(name)) continue;

    scanned += 1;
    examine(full.slice(ROOT.length + 1), readFileSync(full, "utf8"));
  }
}

walk(ROOT);

/**
 * The rules that keep the rest of this file meaningful.
 *
 * Every shape check above is an approximation of "what would be published",
 * and `.gitignore` is the exact answer. If `data/` stops being ignored, the
 * database and the settings file — the two things this whole script exists to
 * keep out — become one `git add -A` away, while every check above still
 * passes because it never looked in the directory it was told to skip.
 */
const gitignorePath = join(ROOT, ".gitignore");
if (!existsSync(gitignorePath)) {
  findings.push({ file: ".gitignore", line: 1, what: "there is no .gitignore, so nothing is private" });
} else {
  const rules = readFileSync(gitignorePath, "utf8")
    .split("\n")
    .map((line) => line.trim());
  for (const required of ["data/", ".env", "node_modules/"]) {
    if (!rules.includes(required)) {
      findings.push({
        file: ".gitignore",
        line: 1,
        what: `the "${required}" rule is gone; without it this file cannot protect anything`,
      });
    }
  }
}

const coverage =
  VALUES.length > 0
    ? `also checked by content: ${VALUES.map(
        (entry) => `${entry.name} in ${entry.source}, ${entry.value.length} chars`,
      ).join("; ")}`
    : "no .env or data/settings.json on this machine, so only known shapes were checked";

if (findings.length === 0) {
  console.log(`  ok    ${scanned} files, nothing private found (${coverage})`);
  process.exit(0);
}

console.log(`  FAIL  ${findings.length} potential leak(s) in ${scanned} files (${coverage})\n`);
for (const finding of findings) {
  console.log(`    ${finding.file}:${finding.line}  ${finding.what}`);
  if (finding.around) console.log(`        ${finding.around}`);
}
console.log(
  "\n  If a finding is a deliberate fake, mark that line with the comment\n" +
    `  \`${DELIBERATE}\`. If it is real, rotate the credential before removing it:\n` +
    "  a value that reached a commit is compromised even after it is deleted.\n",
);
process.exit(1);
