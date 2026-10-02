"use client";

import { useMemo, useState } from "react";

import { MEMORY_KINDS, type MemoryRecord } from "@/lib/cave/types";

import type { CaveController } from "./useCave";

/**
 * The memory room: what she believes, and the controls to correct it.
 *
 * WHY THIS SCREEN EXISTS
 *
 * Recall is a ranking. Without a way to see the contents, a wrong memory is
 * undiagnosable: she says something confidently false and there is no way to
 * find out where it came from. And without a way to remove or correct one,
 * the only available fix is to argue with her, which does not change the
 * record.
 *
 * Three controls, each answering a question the user actually has:
 *
 *  - **Pin** — "this matters, do not let it fade." Raises salience as well as
 *    setting the flag, because the blend ranks on salience and the flag only
 *    exempts from decay.
 *  - **Edit** — "this is nearly right." Re-embeds on save, so the corrected
 *    wording is what recall searches, not the words that were removed.
 *  - **Forget** — "this should not be known." Twice confirmed, and then the row
 *    leaves memory entirely rather than getting a flag: a superseded record
 *    would still be in `allMemories` and still reachable by a high-scoring
 *    recall. It goes to the trash rather than nowhere, so the confirmation can
 *    be about the mistake instead of about the loss.
 */

const KIND_TONE: Record<string, string> = {
  person: "border-good/30 text-good",
  place: "border-good/30 text-good",
  project: "border-accent/30 text-accent",
  decision: "border-warn/30 text-warn",
  preference: "border-accent/30 text-accent",
  fact: "border-hairline-2 text-dim",
  conversation: "border-hairline text-faint",
  note: "border-hairline text-dim",
};

export interface MemoryRoomProps {
  controller: CaveController;
}

export default function MemoryRoom({ controller }: MemoryRoomProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<string>("");
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState({ title: "", content: "", kind: "fact" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ title: "", content: "" });
  const [forgettingId, setForgettingId] = useState<string | null>(null);

  const items = controller.memories?.items ?? [];
  const stats = controller.memories?.stats;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((record) => {
      if (kind && record.kind !== kind) return false;
      if (!needle) return true;
      return [record.title, record.content, ...record.tags]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [items, kind, query]);

  const saveNew = () => {
    const title = draft.title.trim();
    if (!title) return;
    void controller.run("memory.create", {
      title,
      content: draft.content.trim() || title,
      kind: draft.kind,
    });
    setDraft({ title: "", content: "", kind: "fact" });
    setWriting(false);
  };

  const startEdit = (record: MemoryRecord) => {
    setEditingId(record.id);
    setEdit({ title: record.title, content: record.content });
  };

  const saveEdit = () => {
    if (!editingId) return;
    const title = edit.title.trim();
    const content = edit.content.trim();
    if (!title || !content) {
      setEditingId(null);
      return;
    }
    void controller.run("memory.update", { id: editingId, title, content }, editingId);
    setEditingId(null);
  };

  return (
    <div>
      {/* ---------------- summary + controls ---------------- */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-hairline px-6 py-5">
        <div>
          <h3 className="text-[15px] font-normal text-text">What she remembers</h3>
          <p className="mt-1 max-w-[60ch] text-[13px] leading-relaxed font-light text-dim">
            {stats
              ? `${stats.total} memories${stats.pinned > 0 ? `, ${stats.pinned} pinned` : ""}. Pinned entries never fade and always rank highest in recall.`
              : "Reading…"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setWriting((value) => !value)}
          className="btn btn-ghost"
        >
          {writing ? "Cancel" : "Teach her something"}
        </button>
      </div>

      {/* ---------------- write one by hand ---------------- */}
      {writing ? (
        <div className="card-entry border-b border-hairline px-6 py-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px]">
            <input
              autoFocus
              value={draft.title}
              placeholder="A short title, the way she would say it"
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveNew();
                if (event.key === "Escape") setWriting(false);
              }}
              className="field"
            />
            <select
              value={draft.kind}
              onChange={(event) => setDraft({ ...draft, kind: event.target.value })}
              aria-label="Kind of memory"
              className="field select"
            >
              {MEMORY_KINDS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <textarea
            rows={3}
            value={draft.content}
            placeholder="The detail worth keeping. She will recall this by meaning, not just by words."
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
            className="field mt-3 resize-y"
          />
          <div className="mt-3 flex items-center gap-3">
            <button type="button" onClick={saveNew} className="btn btn-primary" disabled={!draft.title.trim()}>
              Keep it
            </button>
            <span className="text-[12px] font-normal text-faint">
              Marked as yours, so it outranks what she infers on her own.
            </span>
          </div>
        </div>
      ) : null}

      {/* ---------------- filters ---------------- */}
      <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-6 py-3">
        <input
          value={query}
          placeholder="Search what she knows"
          onChange={(event) => setQuery(event.target.value)}
          className="field max-w-[280px]"
        />
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setKind("")}
            aria-pressed={kind === ""}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-normal ${
              kind === "" ? "border-accent/40 bg-accent/10 text-text" : "border-hairline text-dim hover:text-text"
            }`}
          >
            all
          </button>
          {(stats?.byKind ?? []).map((entry) => (
            <button
              key={entry.kind}
              type="button"
              onClick={() => setKind(entry.kind === kind ? "" : entry.kind)}
              aria-pressed={kind === entry.kind}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-normal ${
                kind === entry.kind
                  ? "border-accent/40 bg-accent/10 text-text"
                  : "border-hairline text-dim hover:text-text"
              }`}
            >
              {entry.kind} <span className="text-faint">{entry.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ---------------- the list ---------------- */}
      <ul className="divide-y divide-hairline">
        {visible.map((record) => (
          <li key={record.id} className="px-6 py-4">
            {editingId === record.id ? (
              <div>
                <input
                  autoFocus
                  value={edit.title}
                  onChange={(event) => setEdit({ ...edit, title: event.target.value })}
                  className="field"
                />
                <textarea
                  rows={3}
                  value={edit.content}
                  onChange={(event) => setEdit({ ...edit, content: event.target.value })}
                  className="field mt-2 resize-y"
                />
                <div className="mt-2 flex items-center gap-3">
                  <button type="button" onClick={saveEdit} className="btn btn-primary">
                    Save correction
                  </button>
                  <button type="button" onClick={() => setEditingId(null)} className="btn btn-ghost">
                    Cancel
                  </button>
                  <span className="text-[11px] font-normal text-faint">
                    The embedding is rebuilt, so the old wording stops matching.
                  </span>
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2 py-[1px] text-[10px] font-medium tracking-[0.12em] uppercase ${
                          KIND_TONE[record.kind] ?? "border-hairline text-faint"
                        }`}
                      >
                        {record.kind}
                      </span>
                      {record.pinned ? (
                        <span className="rounded-full border border-accent/40 px-2 py-[1px] text-[10px] font-medium tracking-[0.12em] text-accent uppercase">
                          pinned
                        </span>
                      ) : null}
                      {record.source === "user" ? (
                        <span className="text-[10px] tracking-[0.12em] text-faint uppercase">
                          yours
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1.5 text-[14px] leading-snug font-normal text-text">
                      {record.title}
                    </p>
                    <p className="mt-1 max-w-[76ch] text-[13px] leading-relaxed font-light text-dim">
                      {record.content}
                    </p>
                    <p className="mt-1.5 text-[11px] font-normal text-faint">
                      {new Date(record.createdAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                      {record.accessCount > 0
                        ? ` · recalled ${record.accessCount} time${record.accessCount === 1 ? "" : "s"}`
                        : " · never recalled"}
                      {record.tags.length > 0 ? ` · ${record.tags.slice(0, 4).join(", ")}` : ""}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        void controller.run(
                          "memory.pin",
                          { id: record.id, pinned: !record.pinned },
                          record.id,
                        )
                      }
                      className={`rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-normal hover:bg-surface-2 ${
                        record.pinned ? "text-accent" : "text-dim hover:text-text"
                      }`}
                    >
                      {record.pinned ? "unpin" : "pin"}
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(record)}
                      className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-normal text-dim hover:bg-surface-2 hover:text-text"
                    >
                      edit
                    </button>
                    {forgettingId === record.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            void controller.run("memory.forget", { id: record.id }, record.id);
                            setForgettingId(null);
                          }}
                          className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-normal text-danger hover:bg-surface-2"
                        >
                          forget
                        </button>
                        <button
                          type="button"
                          onClick={() => setForgettingId(null)}
                          className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-normal text-dim hover:bg-surface-2"
                        >
                          keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setForgettingId(record.id)}
                        className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-normal text-faint hover:bg-surface-2 hover:text-danger"
                      >
                        forget
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </li>
        ))}

        {visible.length === 0 ? (
          <li className="px-6 py-10 text-center">
            <p className="text-[13px] font-light text-dim">
              {items.length === 0
                ? "Nothing remembered yet. Tell her something in the chat, or write one above."
                : "Nothing matches that."}
            </p>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
