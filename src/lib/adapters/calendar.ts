/**
 * Calendar adapter.
 *
 * Live mode: subscribes to any published ICS feed. Google Calendar, Outlook and
 * Fastmail all expose a private ICS URL, which means real schedule data with no
 * OAuth dance and no server-side token custody — the right trade for a
 * single-user local assistant.
 *
 * Local mode: events Xana herself created, read from SQLite.
 *
 *   XANA_CALENDAR_ICS_URLS="https://calendar.google.com/.../basic.ics,https://..."
 */

import type { AdapterStatus, CalendarEvent } from "../core/types";
import { getStore } from "../core/store";
import { endOfDay, startOfDay, addDays, uid } from "../core/time";
import {
  addDaysInZone,
  addMonthsInZone,
  fromDateKeyInZone,
  instantFromWallClock,
  weekdayIndexInZone,
} from "../core/zone";
import {
  cred,
  defineAdapter,
  errorMessage,
  httpText,
  status,
  type LifeAdapter,
} from "./types";

/** Minimal but correct-enough ICS unfolding, per RFC 5545 §3.1. */
function unfold(ics: string): string[] {
  const raw = ics.replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

/**
 * "20240517T140000Z" | "20240517T140000" | "20240517" -> Date | undefined
 *
 * All four shapes RFC 5545 allows land in the app's zone. `Z` is already
 * absolute and needs no conversion; a floating time is read as the app's own
 * wall clock; a `TZID` names its zone; `VALUE=DATE` is a whole day, so it
 * starts at that day's midnight in the app's zone.
 */
function parseIcsDate(value: string, tzid?: string): Date | undefined {
  const v = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    return fromDateKeyInZone(`${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`);
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, z] = m;
  const wall = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s),
  };
  if (z) {
    // UTC. Built from the epoch so the instant is exact; every reader formats it
    // in the app's zone, which is where the eight hour shift becomes visible.
    return new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second));
  }
  // Floating or TZID-qualified. Node resolves TZID names via Intl.
  if (tzid) {
    try {
      return instantFromWallClock(wall, tzid);
    } catch {
      // An unknown zone name falls through to the app's zone, which is a real
      // answer rather than a crash on someone else's calendar.
    }
  }
  return instantFromWallClock(wall);
}

function splitProp(line: string): { name: string; params: Record<string, string>; value: string } {
  const colon = line.indexOf(":");
  if (colon === -1) return { name: line.toUpperCase(), params: {}, value: "" };
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(";");
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

export interface IcsParseOptions {
  source: string;
  from: Date;
  to: Date;
  /** Stable id prefix so repeated polls upsert instead of duplicating. */
  idPrefix?: string;
}

/**
 * Parse VEVENTs overlapping [from, to). Recurrence (RRULE) is expanded for the
 * common DAILY/WEEKLY/MONTHLY/YEARLY + COUNT/UNTIL/INTERVAL cases, which covers
 * essentially all real personal calendars.
 */
export function parseIcs(ics: string, opts: IcsParseOptions): CalendarEvent[] {
  const lines = unfold(ics);
  const out: CalendarEvent[] = [];
  let cur: Record<string, { value: string; params: Record<string, string> }> | null = null;
  let inEvent = false;

  const flush = () => {
    if (!cur) return;
    const startProp = cur.DTSTART;
    if (!startProp) {
      cur = null;
      return;
    }
    const start = parseIcsDate(startProp.value, startProp.params.TZID);
    if (!start) {
      cur = null;
      return;
    }
    const endProp = cur.DTEND;
    const end = endProp ? parseIcsDate(endProp.value, endProp.params.TZID) : undefined;
    const durationMs = end && end > start ? end.getTime() - start.getTime() : 30 * 60_000;
    const allDay = !startProp.value.includes("T");
    const title = unescapeText(cur.SUMMARY?.value ?? "Untitled");
    const baseUid = cur.UID?.value ?? uid("ics");
    const rrule = cur.RRULE?.value;

    const occurrences = rrule
      ? expandRrule(rrule, start, opts.from, opts.to, allDay)
      : start >= opts.from && start < opts.to
        ? [start]
        : [];

    for (const occ of occurrences) {
      const occEnd = new Date(occ.getTime() + durationMs);
      out.push({
        id: `${opts.idPrefix ?? opts.source}_${baseUid}_${occ.toISOString()}`.replace(/[^\w:@.-]/g, "_"),
        title,
        start: occ.toISOString(),
        end: occEnd.toISOString(),
        location: cur.LOCATION ? unescapeText(cur.LOCATION.value) : undefined,
        attendees: collectAttendees(cur),
        source: opts.source,
        allDay,
      });
    }
    cur = null;
  };

  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      inEvent = true;
      cur = {};
      continue;
    }
    if (line.startsWith("END:VEVENT")) {
      flush();
      inEvent = false;
      continue;
    }
    if (!inEvent || !cur) continue;
    const { name, params, value } = splitProp(line);
    if (name === "ATTENDEE") {
      cur[`ATTENDEE_${Object.keys(cur).length}`] = { value, params };
      continue;
    }
    cur[name] = { value, params };
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

function collectAttendees(cur: Record<string, { value: string; params: Record<string, string> }>): string[] {
  const names: string[] = [];
  for (const [key, prop] of Object.entries(cur)) {
    if (!key.startsWith("ATTENDEE")) continue;
    const cn = prop.params.CN;
    const raw = prop.value.replace(/^mailto:/i, "");
    const name = cn ? unescapeText(cn) : raw.split("@")[0].replace(/[._]/g, " ");
    if (name) names.push(name);
  }
  return names;
}

function expandRrule(
  rrule: string,
  start: Date,
  from: Date,
  to: Date,
  allDay: boolean,
): Date[] {
  const parts: Record<string, string> = {};
  for (const chunk of rrule.split(";")) {
    const [k, v] = chunk.split("=");
    if (k && v) parts[k.toUpperCase()] = v;
  }
  const freq = parts.FREQ;
  const interval = Math.max(1, Number(parts.INTERVAL ?? 1));
  const count = parts.COUNT ? Number(parts.COUNT) : undefined;
  const until = parts.UNTIL ? parseIcsDate(parts.UNTIL) : undefined;
  const byDay = parts.BYDAY?.split(",").filter(Boolean) ?? [];

  if (!freq) return start >= from && start < to ? [start] : [];

  // Hard ceiling: a bad RRULE must never spin.
  const MAX = 500;
  const out: Date[] = [];
  let cursor = new Date(start);
  const stepDays = freq === "DAILY" ? interval : freq === "WEEKLY" ? 7 * interval : 0;

  if (freq === "DAILY" || freq === "WEEKLY") {
    for (let i = 0, guard = 0; i < MAX && guard < 3000; guard++) {
      if (until && cursor > until) break;
      if (count !== undefined && i >= count) break;
      if (cursor >= to) break;

      if (freq === "WEEKLY" && byDay.length) {
        // The week is the app's week, and every occurrence keeps the series'
        // wall-clock time: stepping by days in the zone is what makes an 09:00
        // class stay at 09:00 in the zone the app displays, on any host.
        const weekStart = addDaysInZone(cursor, -weekdayIndexInZone(cursor));
        for (const day of byDay) {
          const target = "MO TU WE TH FR SA SU".split(" ").indexOf(day.slice(-2));
          if (target < 0) continue;
          const occ = addDaysInZone(weekStart, target);
          if (occ < start) continue;
          if (until && occ > until) continue;
          if (occ >= from && occ < to) out.push(occ);
        }
        cursor = addDaysInZone(cursor, stepDays);
        i++;
        continue;
      }

      if (cursor >= from && cursor < to) out.push(new Date(cursor));
      cursor = addDaysInZone(cursor, stepDays);
      i++;
    }
    return out;
  }

  if (freq === "MONTHLY" || freq === "YEARLY") {
    const stepMonths = freq === "MONTHLY" ? interval : 12 * interval;
    for (let i = 0; i < MAX; i++) {
      if (until && cursor > until) break;
      if (count !== undefined && i >= count) break;
      if (cursor >= to) break;
      if (cursor >= from && cursor < to) out.push(new Date(cursor));
      cursor = addMonthsInZone(cursor, stepMonths);
    }
    return out;
  }

  // Unsupported FREQ (e.g. HOURLY): treat as a single occurrence.
  return start >= from && start < to ? [start] : [];
}

/**
 * Build the calendar adapter.
 *
 * `mayFetch` is the user's answer to "may Xana fetch the feed URLs you gave
 * her". It is passed in rather than looked up, because an adapter has no
 * business reading the permission store and — more to the point — because the
 * decision has to be made in one place. When it is false the ICS branch is not
 * taken at all: no request is constructed, so there is nothing to accidentally
 * call. Her own events are read either way; they are in her own database.
 */
export function calendarAdapter(opts: { mayFetch?: boolean } = {}): LifeAdapter {
  const mayFetch = opts.mayFetch ?? false;
  // `calendar.icsUrls` is the plugin's own key. The `XANA_*` name beside it is
  // the flat key this feature used before plugins existed: still read, so an
  // exported environment variable keeps working, but no longer what the panel
  // writes.
  const icsCred = cred("calendar.icsUrls", "XANA_CALENDAR_ICS_URLS", "XANA_CALENDAR_ICS_URL");
  // A feed URL with no permission to fetch it is treated as no feed at all, so
  // the label, the branch below, and the status line all agree.
  const icsConfigured = mayFetch && icsCred.present;
  const id = "calendar";
  const label = icsConfigured ? "Calendar (ICS)" : "Calendar";

  const read = async (): Promise<{ data: { events: CalendarEvent[] }; status: AdapterStatus }> => {
    const t0 = Date.now();
    const store = getStore();
    const from = startOfDay();
    const to = endOfDay(addDays(new Date(), 7));

    // Local events are always merged in — they are Xana's own write-back.
    const local = store.eventsBetween(from.toISOString(), to.toISOString());
    const events: CalendarEvent[] = local.map((e) => ({ ...e, source: e.source || "local" }));

    if (!icsConfigured) {
      const blocked = icsCred.present && !mayFetch;
      return {
        data: { events },
        status: status(
          id, label, "local", "local",
          blocked
            ? "Feed URLs are saved. Allow network access to fetch them."
            : local.length > 0
              ? `${local.length} local events · paste an ICS feed URL, or connect Google Calendar, to sync`
              : "Paste an ICS feed URL, or connect Google Calendar",
          Date.now() - t0,
        ),
      };
    }

    const urls = icsCred.value.split(/[,\s]+/).filter(Boolean);
    let imported = 0;
    const failures: string[] = [];
    for (const url of urls) {
      try {
        const body = await httpText(url, { timeoutMs: 6000 });
        const parsed = parseIcs(body, {
          source: "ics",
          from: startOfDay(),
          to: endOfDay(addDays(new Date(), 21)),
          idPrefix: "ics",
        });
        events.push(...parsed);
        imported += parsed.length;
      } catch (err) {
        failures.push(errorMessage(err));
      }
    }

    if (imported === 0 && failures.length === urls.length) {
      return {
        data: { events },
        status: status(id, label, "error", "local", `ICS unreachable: ${failures[0]}`, Date.now() - t0),
      };
    }
    return {
      data: { events },
      status: status(
        id, label, "connected", "live",
        `${imported} from feed · ${local.length} local`,
        Date.now() - t0,
      ),
    };
  };

  return defineAdapter<{ events: CalendarEvent[] }>({
    id,
    label,
    ttlMs: 60_000,
    empty: { events: [] },
    produce: read,
  });
}
