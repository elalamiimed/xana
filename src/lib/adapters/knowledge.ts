/**
 * Knowledge adapter — notes from Xana's store plus any local Obsidian vault.
 *
 * Obsidian vaults are plain Markdown directories, so Xana reads them directly
 * with no plugin or sync service. Set `XANA_OBSIDIAN_VAULT` to the vault path.
 * Markdown is stripped of syntax before it reaches the memory layer, because
 * embeddings of `[[wikilinks]]` and `##` headings are noise.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AdapterStatus, Note } from "../core/types";
import { getStore } from "../core/store";
import { cred, defineAdapter, status, type LifeAdapter } from "./types";

const MAX_FILES = 200;
const MAX_CHARS = 4000;

/** Strip the Markdown scaffolding, keep the prose Xana would actually read. */
export function stripMarkdown(body: string): string {
  return body
    .replace(/^---\n[\s\S]*?\n---\n/, "")          // YAML frontmatter
    .replace(/```[\s\S]*?```/g, " ")                // fenced code
    .replace(/`([^`]+)`/g, "$1")                    // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")          // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")        // links -> label
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1") // wikilinks -> target
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")             // headings
    .replace(/^\s{0,3}>\s?/gm, "")                  // blockquotes
    .replace(/^\s*[-*+]\s+/gm, "")                  // bullets
    .replace(/[*_~]{1,3}/g, "")                     // emphasis
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walkMarkdown(dir: string, out: string[], depth = 0): void {
  if (depth > 4 || out.length >= MAX_FILES) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) walkMarkdown(full, out, depth + 1);
      else if (entry.toLowerCase().endsWith(".md")) out.push(full);
    } catch {
      /* unreadable entry: skip */
    }
  }
}

export function readVault(vaultPath: string): Note[] {
  const files: string[] = [];
  walkMarkdown(vaultPath, files);

  const notes: Note[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(file, "utf8");
      const body = stripMarkdown(raw).slice(0, MAX_CHARS);
      if (body.length < 24) continue; // skip stubs and empty daily notes
      const st = statSync(file);
      const rel = path.relative(vaultPath, file).replace(/\\/g, "/");
      notes.push({
        id: `obsidian_${rel}`,
        title: path.basename(file, ".md"),
        body,
        source: "obsidian",
        tags: rel.split("/").slice(0, -1),
        createdAt: st.birthtime.toISOString(),
        updatedAt: st.mtime.toISOString(),
      });
    } catch {
      /* skip unreadable file */
    }
  }
  // Most recently touched first — those are what the user is living in.
  return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function knowledgeAdapter(): LifeAdapter {
  const vault = cred("notes.vault", "XANA_OBSIDIAN_VAULT");
  // The plugin id: a status row and a permission card have to agree on what to
  // call this, or "Notes: waiting for permission" cannot be clicked through to
  // anything.
  const id = "notes";
  const label = vault.present ? "Notes (Obsidian)" : "Notes";

  const read = async (): Promise<{ data: { notes: Note[] }; status: AdapterStatus }> => {
    const t0 = Date.now();
    const store = getStore();
    const local = store.listNotes(50);
    const notes: Note[] = [...local];

    if (!vault.present) {
      return {
        data: { notes },
        status: status(
          id, label, "local", "local",
          `${local.length} notes · set a vault folder to read Markdown`,
          Date.now() - t0,
        ),
      };
    }

    try {
      const found = readVault(vault.value);
      const localTitles = new Set(local.map((n) => n.title.toLowerCase()));
      const fresh = found.filter((n) => !localTitles.has(n.title.toLowerCase()));
      notes.push(...fresh);
      if (found.length === 0) {
        return {
          data: { notes },
          status: status(id, label, "error", "local", "no markdown notes found in vault", Date.now() - t0),
        };
      }
      return {
        data: { notes },
        status: status(
          id, label, "connected", "live",
          `${fresh.length} from vault · ${local.length} local`,
          Date.now() - t0,
        ),
      };
    } catch {
      return {
        data: { notes },
        status: status(id, label, "error", "local", "vault unreadable", Date.now() - t0),
      };
    }
  };

  return defineAdapter<{ notes: Note[] }>({
    id,
    label,
    ttlMs: 5 * 60_000,
    empty: { notes: [] },
    produce: read,
  });
}
