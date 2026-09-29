/**
 * Mail adapter — ambient importance, not an inbox client.
 *
 * Xana does not want your mail; she wants to know whether anything in it should
 * change your day. IMAP requires credentials custody, so instead she reads a
 * JSON summary from any of:
 *
 *   XANA_MAIL_URL   — an endpoint (n8n, a mail bridge, a Zapier hook)
 *   XANA_MAIL_FILE  — a JSON file a script refreshes
 *
 * The payload is a list of messages; Xana scores importance herself, so the
 * upstream does not have to be clever.
 */

import { readFileSync } from "node:fs";
import type { AdapterStatus, MailSignal } from "../core/types";
import { cred, defineAdapter, errorMessage, httpJson, status, type LifeAdapter } from "./types";

interface RawMail {
  id?: string;
  from?: string;
  fromName?: string;
  subject?: string;
  snippet?: string;
  receivedAt?: string;
  date?: string;
  unread?: boolean;
  flagged?: boolean;
  importance?: number;
}

/** Words that reliably mean "this changes your day". */
const URGENT = /\b(urgent|asap|today|eod|deadline|action required|invoice|contract|sign|confirm|interview|offer|payment|overdue)\b/i;
const NOISE = /\b(newsletter|digest|unsubscribe|no-?reply|promotion|sale|webinar|receipt|shipped|weekly roundup)\b/i;
/** People who matter: Xana remembers them, so names in memory lift importance. */
export function scoreImportance(raw: RawMail, knownPeople: Set<string>): number {
  const haystack = `${raw.from ?? ""} ${raw.fromName ?? ""} ${raw.subject ?? ""} ${raw.snippet ?? ""}`;
  let score = 0.35;

  if (URGENT.test(haystack)) score += 0.3;
  if (NOISE.test(haystack)) score -= 0.3;
  if (raw.flagged) score += 0.25;
  if (raw.unread) score += 0.05;
  if (typeof raw.importance === "number") score = (score + raw.importance) / 2;

  const sender = (raw.fromName ?? raw.from ?? "").toLowerCase();
  for (const person of knownPeople) {
    if (person && sender.includes(person.toLowerCase())) {
      score += 0.2;
      break;
    }
  }
  return Math.max(0, Math.min(1, score));
}

function normalize(raw: RawMail, index: number, knownPeople: Set<string>): MailSignal {
  const subject = (raw.subject ?? "(no subject)").trim();
  const receivedAt = raw.receivedAt ?? raw.date ?? new Date().toISOString();
  const importance = scoreImportance(raw, knownPeople);
  return {
    id: raw.id ?? `mail_${index}_${receivedAt}`,
    from: (raw.fromName ?? raw.from ?? "unknown").replace(/<[^>]*>/, "").trim() || "unknown",
    subject,
    importance,
    receivedAt,
    needsReply: importance >= 0.6 && !NOISE.test(subject),
  };
}

export function extractMailList(payload: unknown): RawMail[] {
  if (Array.isArray(payload)) return payload as RawMail[];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const key of ["messages", "mail", "emails", "items", "data", "value"]) {
      if (Array.isArray(obj[key])) return obj[key] as RawMail[];
    }
  }
  return [];
}

export function mailAdapter(knownPeople: () => string[] = () => []): LifeAdapter {
  const url = cred("XANA_MAIL_URL");
  const file = cred("XANA_MAIL_FILE");
  const configured = url.present || file.present;
  const id = "mail";
  const label = "Mail";

  const read = async (): Promise<{ data: { mail: MailSignal[] }; status: AdapterStatus }> => {
    const t0 = Date.now();
    if (!configured) {
      return {
        data: { mail: [] },
        status: status(
          id, label, "offline", "local",
          "set XANA_MAIL_URL or XANA_MAIL_FILE for ambient mail signals",
          Date.now() - t0,
        ),
      };
    }

    try {
      const payload = url.present
        ? await httpJson<unknown>(url.value, { timeoutMs: 5000 })
        : (JSON.parse(readFileSync(file.value, "utf8")) as unknown);

      const people = new Set(knownPeople());
      const signals = extractMailList(payload)
        .map((m, i) => normalize(m, i, people))
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 5);

      return {
        data: { mail: signals },
        status: status(
          id, label, "connected", "live",
          `${signals.length} threads · ${signals.filter((s) => s.needsReply).length} awaiting you`,
          Date.now() - t0,
        ),
      };
    } catch (err) {
      return {
        data: { mail: [] },
        status: status(id, label, "error", "local", errorMessage(err), Date.now() - t0),
      };
    }
  };

  return defineAdapter<{ mail: MailSignal[] }>({
    id,
    label,
    ttlMs: 3 * 60_000,
    empty: { mail: [] },
    produce: read,
  });
}
