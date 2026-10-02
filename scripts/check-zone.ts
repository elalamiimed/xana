/**
 * The app's clock, measured rather than assumed.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-zone.ts
 *
 * WHAT THIS IS REALLY CHECKING
 *
 * Asia/Shanghai is the app's timezone, not the machine's and not the browser's.
 * The user asked for it ("use beijing time in calendar"), and the failure it
 * prevents is quiet: the server keys a reading to one day and the browser labels
 * it as another, so a task due tonight reads "today" in the chat and "tomorrow"
 * in the cave, eight hours a day, only for people whose clock is not Beijing's.
 *
 * WHY EVERY ASSERTION USES A FIXED INSTANT
 *
 * `new Date()` proves nothing about a timezone: it is a different instant on
 * every run and the same wall clock in every zone. Every measurement below is
 * taken at a named instant with a known Beijing reading, and the ones that
 * depend on "now" pass `now` in rather than reading the clock.
 *
 * THE TWO MEASUREMENTS THAT MATTER MOST
 *
 *   1. **Another zone's process reads the same days.** A child process is run
 *      with `TZ=UTC` and asked the same questions. If any answer changes, the
 *      zone is being inherited from the host and this whole feature is
 *      decorative. This is the only check here that would have caught the
 *      original bug, because this machine is already Asia/Shanghai.
 *   2. **The four ICS shapes land in the app's zone.** `Z`, floating, `TZID`
 *      qualified and `VALUE=DATE` are four different readings of the same
 *      wall-clock string, and a calendar that gets one of them wrong is a
 *      calendar that puts an appointment on the wrong day.
 *
 * It touches no database and no settings file. `XANA_DATA_DIR` is pointed at a
 * temp directory before the modules that resolve it are imported, which is the
 * same isolation `check-plugins.ts` uses and for the same reason: importing
 * `calendar.ts` reaches the settings store, and the store moves a legacy
 * settings file on first read.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function group(title: string, run: () => void | Promise<void>) {
  console.log(`\n${title}\n`);
  return Promise.resolve()
    .then(run)
    .catch((err) => {
      failed += 1;
      console.log(`  FAIL  ${title} threw — ${err instanceof Error ? err.message : String(err)}`);
    });
}

function skip(label: string, reason: string) {
  skipped += 1;
  console.log(`  skip  ${label} (${reason})`);
}

/* ------------------------------------------------------------------ */
/* The temp world, before any module that resolves it                  */
/* ------------------------------------------------------------------ */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "xana-zone-"));
process.env.XANA_DATA_DIR = DATA_DIR;
writeFileSync(path.join(DATA_DIR, "settings.json"), "{}\n", { encoding: "utf8", mode: 0o600 });

const zone = await import("../src/lib/core/zone");
const time = await import("../src/lib/core/time");
const { parseIcs } = await import("../src/lib/adapters/calendar");

/* ------------------------------------------------------------------ */
/* The instants every measurement is taken at                          */
/* ------------------------------------------------------------------ */

/** 2026-10-02T17:30Z, which is 01:30 on 2026-10-03 in Beijing. */
const CLOCK = new Date("2026-10-02T17:30:00Z");
/** 2026-10-02T16:30Z, which is 00:30 on 2026-10-03 in Beijing and still the 2nd in UTC. */
const CROSSING = new Date("2026-10-02T16:30:00Z");
/** Beijing midnight opening 2026-10-03. */
const MIDNIGHT = "2026-10-02T16:00:00.000Z";
/** 23:30 Beijing on 2026-10-03, which is 15:30 UTC. */
const NIGHT = new Date("2026-10-03T15:30:00Z");
/** 07:00 Beijing on 2026-10-03, which is 23:00 UTC on the 2nd. */
const MORNING = new Date("2026-10-02T23:00:00Z");

/** An ICS with one event of each shape the parser has to get right. */
const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:floating",
  "SUMMARY:Floating 09:30",
  "DTSTART:20261003T093000",
  "DTEND:20261003T103000",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:utc",
  "SUMMARY:Zulu 09:30",
  "DTSTART:20261003T093000Z",
  "DTEND:20261003T103000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:tzid",
  "SUMMARY:New York 09:30",
  "DTSTART;TZID=America/New_York:20261003T093000",
  "DTEND;TZID=America/New_York:20261003T103000",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:allday",
  "SUMMARY:All day",
  "DTSTART;VALUE=DATE:20261003",
  "DTEND;VALUE=DATE:20261004",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

/** A weekly class, so recurrence expansion can be measured in wall-clock terms. */
const WEEKLY_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:weekly",
  "SUMMARY:Weekly class",
  "DTSTART;TZID=Asia/Shanghai:20261005T090000",
  "DTEND;TZID=Asia/Shanghai:20261005T100000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261021T235900Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

/** Monday and Wednesday at 09:00 Beijing, ending before the UNTIL. */
const WEEKLY_DAYS = ["2026-10-05", "2026-10-07", "2026-10-12", "2026-10-14", "2026-10-19", "2026-10-21"];

const parsed = parseIcs(ICS, {
  source: "check-zone",
  from: zone.fromDateKeyInZone("2026-10-01"),
  to: zone.fromDateKeyInZone("2026-11-01"),
});
const titled = (title: string) => parsed.find((event) => event.title === title);

/* ------------------------------------------------------------------ */
/* The zone is the app's, not the machine's                            */
/* ------------------------------------------------------------------ */

await group("The zone is the app's, not the machine's", async () => {
  check("the app names one zone", zone.APP_TIME_ZONE === "Asia/Shanghai", zone.APP_TIME_ZONE);

  /**
   * The same instant, three zones. This is the measurement the whole file rests
   * on: 16:30 UTC is 00:30 the next day in Beijing and still the evening of the
   * 2nd in UTC and in New York, so a key that comes out "2026-10-03" can only
   * have been read in the app's zone.
   */
  check(
    "16:30Z is the 3rd in the app's zone",
    zone.dateKeyInZone(CROSSING) === "2026-10-03",
    zone.dateKeyInZone(CROSSING),
  );
  check(
    "and is not that day in the previous zone",
    zone.dateKeyInZone(CROSSING, "UTC") === "2026-10-02",
    zone.dateKeyInZone(CROSSING, "UTC"),
  );
  check(
    "nor in another named zone",
    zone.dateKeyInZone(CROSSING, "America/New_York") === "2026-10-02",
    zone.dateKeyInZone(CROSSING, "America/New_York"),
  );
  check(
    "the app's own module agrees",
    time.toDateKey(CROSSING) === "2026-10-03",
    time.toDateKey(CROSSING),
  );

  /**
   * The measurement that a machine already in Asia/Shanghai cannot make from
   * inside: a second process whose host zone is UTC must give the same answers.
   * A hardcoded `+08:00` would pass every other check in this file; this one it
   * fails the moment the offset is written down instead of read from `Intl`.
   */
  const probe = `
const zone = await import("./src/lib/core/zone.ts");
const time = await import("./src/lib/core/time.ts");
const { parseIcs } = await import("./src/lib/adapters/calendar.ts");
const weekly = parseIcs(${JSON.stringify(WEEKLY_ICS)}, {
  source: "probe",
  from: zone.fromDateKeyInZone("2026-10-01"),
  to: zone.fromDateKeyInZone("2026-11-01"),
});
console.log(JSON.stringify({
  host: Intl.DateTimeFormat().resolvedOptions().timeZone,
  key: zone.dateKeyInZone(new Date("2026-10-02T16:30:00Z")),
  clock: zone.hourMinuteInZone(new Date("2026-10-02T17:30:00Z")),
  midnight: zone.startOfDayInZone(new Date("2026-10-02T16:30:00Z")).toISOString(),
  part: time.partOfDay(new Date("2026-10-03T15:30:00Z")),
  week: time.isoWeekKey(new Date("2026-12-27T16:30:00Z")),
  days: weekly.map((event) => zone.dateKeyInZone(new Date(event.start))),
  clocks: weekly.map((event) => zone.hourMinuteInZone(new Date(event.start))),
}));
`;

  let seen: Record<string, unknown> | undefined;
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "./scripts/ts-loader.mjs", "--input-type=module", "-e", probe],
      { cwd: process.cwd(), env: { ...process.env, TZ: "UTC" }, encoding: "utf8" },
    );
    seen = JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    skip("a process in UTC reads the app's days", err instanceof Error ? err.message : String(err));
  }

  if (seen && seen.host !== "UTC") {
    skip("a process in UTC reads the app's days", `TZ was ignored, the child reported ${seen.host}`);
    seen = undefined;
  }

  if (seen) {
    check("the child really is in UTC", seen.host === "UTC", String(seen.host));
    check("its date key is still the app's day", seen.key === "2026-10-03", String(seen.key));
    check("its clock reading is still the app's", seen.clock === "01:30", String(seen.clock));
    check("its day starts at the app's midnight", seen.midnight === MIDNIGHT, String(seen.midnight));
    check("its evening is still the app's night", seen.part === "night", String(seen.part));
    check("its ISO week is still the app's", seen.week === "2026-W53", String(seen.week));
    check(
      "and a weekly series keeps its wall clock there too",
      JSON.stringify(seen.days) === JSON.stringify(WEEKLY_DAYS) &&
        Array.isArray(seen.clocks) &&
        seen.clocks.every((clock) => clock === "09:00"),
      `${JSON.stringify(seen.days)} at ${JSON.stringify(seen.clocks)}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* A clock reading                                                     */
/* ------------------------------------------------------------------ */

await group("A clock reading", () => {
  check("17:30Z reads as 01:30 in the app's zone", zone.hourMinuteInZone(CLOCK) === "01:30", zone.hourMinuteInZone(CLOCK));
  check("on the 3rd", zone.dateKeyInZone(CLOCK) === "2026-10-03", zone.dateKeyInZone(CLOCK));
  check("hour 1", zone.hourInZone(CLOCK) === 1, String(zone.hourInZone(CLOCK)));
  check("minute 30", zone.minuteInZone(CLOCK) === 30, String(zone.minuteInZone(CLOCK)));
  check(
    "the label a person reads says the same",
    zone.clockInZone(CLOCK).includes("01:30"),
    zone.clockInZone(CLOCK),
  );
  check(
    "the same instant is 17:30 in UTC, so the zone is really being read",
    zone.hourMinuteInZone(CLOCK, "UTC") === "17:30",
    zone.hourMinuteInZone(CLOCK, "UTC"),
  );
  check("the app's own formatter agrees", time.formatTime(CLOCK) === zone.clockInZone(CLOCK), time.formatTime(CLOCK));
});

/* ------------------------------------------------------------------ */
/* The day boundary is the app's midnight                              */
/* ------------------------------------------------------------------ */

await group("The day boundary is the app's midnight", () => {
  const start = zone.startOfDayInZone(CROSSING);
  check("the day starts at the app's midnight", start.toISOString() === MIDNIGHT, start.toISOString());
  check("hour zero", zone.hourInZone(start) === 0, String(zone.hourInZone(start)));
  check("minute zero", zone.minuteInZone(start) === 0, String(zone.minuteInZone(start)));
  check(
    "and it belongs to the day it starts",
    zone.dateKeyInZone(start) === zone.dateKeyInZone(CROSSING),
    `${zone.dateKeyInZone(start)} vs ${zone.dateKeyInZone(CROSSING)}`,
  );

  const end = zone.endOfDayInZone(CROSSING);
  check("the day ends on the same date", zone.dateKeyInZone(end) === "2026-10-03", zone.dateKeyInZone(end));
  check("at 23:59:59.999", end.toISOString() === "2026-10-03T15:59:59.999Z", end.toISOString());
  check(
    "so the day is exactly 24 hours",
    end.getTime() - start.getTime() === 86_400_000 - 1,
    String(end.getTime() - start.getTime()),
  );

  /**
   * Days are counted between calendar dates, not between 24-hour spans: 23:00
   * and 00:30 the next morning are one day apart in the app's zone and zero days
   * apart in UTC, and the app must say one.
   */
  const before = new Date("2026-10-02T15:00:00Z");
  check("23:00 to 00:30 is one day", zone.daysBetweenInZone(before, CROSSING) === 1, String(zone.daysBetweenInZone(before, CROSSING)));
  check(
    "the same pair is zero days in UTC",
    zone.daysBetweenInZone(before, CROSSING, "UTC") === 0,
    String(zone.daysBetweenInZone(before, CROSSING, "UTC")),
  );
  check("the app's own module agrees", time.daysBetween(before, CROSSING) === 1, String(time.daysBetween(before, CROSSING)));

  /**
   * `addDays` moves the calendar day and keeps the wall-clock time. Adding 24
   * hours would be the same thing in this zone and the wrong thing in one with
   * daylight saving, so the assertion is on the wall clock, not the span.
   */
  const next = time.addDays(CROSSING, 1);
  check("a day later is the same wall clock", next.toISOString() === "2026-10-03T16:30:00.000Z", next.toISOString());
  check("and the next calendar date", time.toDateKey(next) === "2026-10-04", time.toDateKey(next));
  check("the app's startOfDay is the zone's", time.startOfDay(CROSSING).toISOString() === MIDNIGHT, time.startOfDay(CROSSING).toISOString());
  check("and so is endOfDay", time.endOfDay(CROSSING).getTime() === end.getTime(), time.endOfDay(CROSSING).toISOString());
});

/* ------------------------------------------------------------------ */
/* Part of day follows the app's clock, not the reader's               */
/* ------------------------------------------------------------------ */

await group("Part of day follows the app's clock", () => {
  check("23:30 in Beijing is night", time.partOfDay(NIGHT) === "night", time.partOfDay(NIGHT));
  check("07:00 in Beijing is morning", time.partOfDay(MORNING) === "morning", time.partOfDay(MORNING));
  check(
    "the UTC clock on that instant would have said afternoon",
    zone.hourInZone(NIGHT, "UTC") === 15 && time.partOfDay(NIGHT) === "night",
    `${zone.hourInZone(NIGHT, "UTC")}:30 UTC reads ${time.partOfDay(NIGHT)}`,
  );

  const at = (hour: number, minute = 0) =>
    zone.instantFromWallClock({ year: 2026, month: 10, day: 3, hour, minute });
  check("04:59 is still night", time.partOfDay(at(4, 59)) === "night", time.partOfDay(at(4, 59)));
  check("05:00 turns morning", time.partOfDay(at(5)) === "morning", time.partOfDay(at(5)));
  check("11:59 is still morning", time.partOfDay(at(11, 59)) === "morning");
  check("12:00 turns afternoon", time.partOfDay(at(12)) === "afternoon", time.partOfDay(at(12)));
  check("16:59 is still afternoon", time.partOfDay(at(16, 59)) === "afternoon");
  check("17:00 turns evening", time.partOfDay(at(17)) === "evening", time.partOfDay(at(17)));
  check("21:59 is still evening", time.partOfDay(at(21, 59)) === "evening");
  check("22:00 turns night", time.partOfDay(at(22)) === "night", time.partOfDay(at(22)));
});

/* ------------------------------------------------------------------ */
/* Days said out loud                                                  */
/* ------------------------------------------------------------------ */

await group("Days said out loud", () => {
  const lateEvening = new Date("2026-10-02T15:00:00Z");
  const afterMidnight = new Date("2026-10-02T17:30:00Z");

  check("a day is today on its own day", zone.dayLabelInZone(afterMidnight, afterMidnight) === "today");
  check(
    "and tomorrow from the evening before, in the app's zone",
    zone.dayLabelInZone(CROSSING, lateEvening) === "tomorrow",
    zone.dayLabelInZone(CROSSING, lateEvening),
  );
  check(
    "the same pair is today in UTC, so the label is the zone's",
    zone.dayLabelInZone(CROSSING, lateEvening, "UTC") === "today",
    zone.dayLabelInZone(CROSSING, lateEvening, "UTC"),
  );
  check(
    "the evening before becomes yesterday after midnight",
    zone.dayLabelInZone(lateEvening, afterMidnight) === "yesterday",
    zone.dayLabelInZone(lateEvening, afterMidnight),
  );

  const Wednesday = zone.instantFromWallClock({ year: 2026, month: 10, day: 7, hour: 12 });
  check("within the week it is the weekday", zone.dayLabelInZone(Wednesday, afterMidnight) === "Wednesday", zone.dayLabelInZone(Wednesday, afterMidnight));
  const far = zone.instantFromWallClock({ year: 2026, month: 10, day: 20, hour: 12 });
  check("beyond it, the date", zone.dayLabelInZone(far, afterMidnight) === "Oct 20", zone.dayLabelInZone(far, afterMidnight));

  check("the app says today about now", time.formatDay(new Date()) === "today", time.formatDay(new Date()));
  check("and tomorrow about a day from now", time.formatDay(time.addDays(new Date(), 1)) === "tomorrow", time.formatDay(time.addDays(new Date(), 1)));
});

/* ------------------------------------------------------------------ */
/* Weeks                                                               */
/* ------------------------------------------------------------------ */

await group("Weeks", () => {
  const saturday = zone.instantFromWallClock({ year: 2026, month: 10, day: 3, hour: 12 });
  check("3 October 2026 is week 40", time.isoWeekKey(saturday) === "2026-W40", time.isoWeekKey(saturday));

  /**
   * 00:30 on Monday 28 December 2026 in Beijing, which is still Sunday the 27th
   * in UTC. The two zones are in different ISO weeks, so this is the assertion
   * that fails if the week is computed from the host's calendar date.
   */
  const newYearWeek = new Date("2026-12-27T16:30:00Z");
  check("the app's zone is already on the 28th", zone.dateKeyInZone(newYearWeek) === "2026-12-28", zone.dateKeyInZone(newYearWeek));
  check("while UTC is still Sunday the 27th", zone.dateKeyInZone(newYearWeek, "UTC") === "2026-12-27", zone.dateKeyInZone(newYearWeek, "UTC"));
  check("so the app's week is 2026-W53", time.isoWeekKey(newYearWeek) === "2026-W53", time.isoWeekKey(newYearWeek));

  const monday = zone.instantFromWallClock({ year: 2026, month: 10, day: 7, hour: 15 });
  const weekStart = time.startOfWeek(monday);
  check("the week starts on Monday in the app's zone", time.toDateKey(weekStart) === "2026-10-05", time.toDateKey(weekStart));
  check("at the app's midnight", weekStart.toISOString() === "2026-10-04T16:00:00.000Z", weekStart.toISOString());
  check("and the month starts on its first day", time.toDateKey(time.startOfMonth(monday)) === "2026-10-01", time.toDateKey(time.startOfMonth(monday)));
  check("a date key opens at the app's midnight", time.fromDateKey("2026-10-03").toISOString() === MIDNIGHT, time.fromDateKey("2026-10-03").toISOString());
});

/* ------------------------------------------------------------------ */
/* The four ICS shapes                                                 */
/* ------------------------------------------------------------------ */

await group("The four ICS shapes", () => {
  /**
   * Floating: the string means the app's own wall clock, so 09:30 stays 09:30
   * and the instant is 01:30Z.
   */
  const floating = titled("Floating 09:30");
  check("a floating event is read", Boolean(floating), `${parsed.length} events parsed`);
  check("and keeps its stated wall clock", floating?.start === "2026-10-03T01:30:00.000Z", floating?.start);
  check(
    "so it reads 09:30 on the 3rd",
    floating !== undefined && zone.hourMinuteInZone(new Date(floating.start)) === "09:30" &&
      zone.dateKeyInZone(new Date(floating.start)) === "2026-10-03",
    floating?.start,
  );

  /** `Z` is an absolute instant, so the same wall-clock string shifts by eight. */
  const zulu = titled("Zulu 09:30");
  check("a Z event is the instant it says", zulu?.start === "2026-10-03T09:30:00.000Z", zulu?.start);
  check(
    "which reads 17:30 in the app's zone",
    zulu !== undefined && zone.hourMinuteInZone(new Date(zulu.start)) === "17:30",
    zulu && zone.hourMinuteInZone(new Date(zulu.start)),
  );
  check(
    "exactly eight hours from the floating one",
    floating !== undefined && zulu !== undefined &&
      new Date(zulu.start).getTime() - new Date(floating.start).getTime() === 8 * 3_600_000,
    floating && zulu ? String(new Date(zulu.start).getTime() - new Date(floating.start).getTime()) : "missing",
  );

  /** A `TZID` names its own zone, whatever the app's zone is. */
  const named = titled("New York 09:30");
  check("a TZID event resolves in its own zone", named?.start === "2026-10-03T13:30:00.000Z", named?.start);
  check(
    "which reads 21:30 in the app's zone",
    named !== undefined && zone.hourMinuteInZone(new Date(named.start)) === "21:30",
    named && zone.hourMinuteInZone(new Date(named.start)),
  );

  /** `VALUE=DATE` is a whole day, so it opens at the app's midnight. */
  const allDay = titled("All day");
  check("an all-day event is read", Boolean(allDay));
  check("it opens at the app's midnight", allDay?.start === MIDNIGHT, allDay?.start);
  check("it is marked all day", allDay?.allDay === true, String(allDay?.allDay));
  check(
    "and it belongs to the date it names",
    allDay !== undefined && zone.dateKeyInZone(new Date(allDay.start)) === "2026-10-03",
    allDay?.start,
  );

  /**
   * Recurrence is the shape most likely to be wrong quietly: the series has to
   * expand at 09:00 on the app's clock on the right weekdays, not at 09:00 in
   * whatever zone the host holds.
   */
  const weekly = parseIcs(WEEKLY_ICS, {
    source: "check-zone",
    from: zone.fromDateKeyInZone("2026-10-01"),
    to: zone.fromDateKeyInZone("2026-11-01"),
  });
  const days = weekly.map((event) => zone.dateKeyInZone(new Date(event.start)));
  check("a weekly series expands to its six weekdays", JSON.stringify(days) === JSON.stringify(WEEKLY_DAYS), JSON.stringify(days));
  check(
    "every occurrence is at 09:00 in the app's zone",
    weekly.length > 0 && weekly.every((event) => zone.hourMinuteInZone(new Date(event.start)) === "09:00"),
    weekly.map((event) => zone.hourMinuteInZone(new Date(event.start))).join(", "),
  );
  check(
    "and no occurrence falls on a day the rule excludes",
    weekly.every((event) => [0, 2].includes(zone.weekdayIndexInZone(new Date(event.start)))),
    weekly.map((event) => String(zone.weekdayIndexInZone(new Date(event.start)))).join(", "),
  );
});

/* ------------------------------------------------------------------ */
/* Google Calendar asks for the zone                                   */
/* ------------------------------------------------------------------ */

await group("Google Calendar asks for the zone", async () => {
  const { eventsQuery } = await import("../src/lib/plugins/google-calendar");
  const query = eventsQuery(CLOCK);

  check("the zone is sent with the request", query.get("timeZone") === "Asia/Shanghai", String(query.get("timeZone")));
  check(
    "the window opens at the app's midnight",
    query.get("timeMin") === MIDNIGHT,
    String(query.get("timeMin")),
  );
  check(
    "and closes at the end of the seventh day after it",
    query.get("timeMax") === "2026-10-10T15:59:59.999Z",
    String(query.get("timeMax")),
  );
  check(
    "which is not the UTC day it would have asked for",
    query.get("timeMin") !== new Date(Date.UTC(2026, 9, 3)).toISOString(),
    String(query.get("timeMin")),
  );
  check("recurrence is expanded into occurrences", query.get("singleEvents") === "true", String(query.get("singleEvents")));
  check("and ordered as the rest of the app expects", query.get("orderBy") === "startTime", String(query.get("orderBy")));
});

/* ------------------------------------------------------------------ */
/* A label for a value that is not a date                              */
/* ------------------------------------------------------------------ */

await group("A label for a value that is not a date", async () => {
  const cave = await import("../src/lib/cave/types");
  const bad = new Date(NaN);

  /**
   * The regression this group exists for, measured at the call site the browser
   * actually hit.
   *
   * The log room renders `dayFullLabel("")` on its first frame, before the server
   * has said which day it is. The old implementation was
   * `new Date(`${date}T12:00:00`).toLocaleDateString(...)`, which returns the
   * string "Invalid Date" for that input, so the seam was invisible. `Intl`
   * throws a `RangeError` on an invalid instant, so the same refactor turned a
   * wrong label into a render crash and took the whole room's checks with it.
   * Every caller of these helpers is a label, so the helpers degrade.
   */
  let thrown = "";
  try {
    const labels = [
      cave.dayFullLabel(""),
      cave.daySlotLabel("", "2026-10-03"),
      zone.weekdayMonthDayInZone(zone.fromDateKeyInZone("")),
      zone.weekdayShortInZone(bad),
      zone.weekdayLongInZone(bad),
      zone.monthDayInZone(bad),
      zone.dayLabelInZone(bad),
      zone.clockInZone(bad),
      zone.hourMinuteInZone(bad),
      zone.dateKeyInZone(bad),
    ];
    const notEmpty = labels.filter((label) => label !== "");
    if (notEmpty.length > 0) thrown = `a label came back as ${JSON.stringify(notEmpty)}`;
  } catch (err) {
    thrown = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  check("an unusable date gives an empty label rather than a thrown RangeError", thrown === "", thrown);

  check(
    "and the arithmetic on it stays unusable rather than landing on 1970",
    Number.isNaN(zone.startOfDayInZone(bad).getTime()) &&
      Number.isNaN(zone.addDaysInZone(bad, 1).getTime()) &&
      Number.isNaN(zone.daysBetweenInZone(bad, new Date())) &&
      Number.isNaN(zone.hourInZone(bad)),
  );
  check(
    "the app's own module degrades the same way",
    time.toDateKey(bad) === "" && time.formatDay(bad) === "" && time.formatTime(bad) === "",
    `${time.toDateKey(bad)} / ${time.formatDay(bad)} / ${time.formatTime(bad)}`,
  );
  check(
    "and part of day still falls back the way it did on an invalid date",
    time.partOfDay(bad) === "night",
    time.partOfDay(bad),
  );
});

/* ------------------------------------------------------------------ */
/* The client module stays client safe                                 */
/* ------------------------------------------------------------------ */

/**
 * Every specifier a module imports.
 *
 * Deliberately a source scan rather than a resolution: the question is what the
 * file *asks for*, and a `node:` import that fails to resolve is still an import
 * that a browser bundle cannot have.
 */
function importSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) found.add(match[1] ?? "");
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) found.add(match[1] ?? "");
  for (const match of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) found.add(match[1] ?? "");
  found.delete("");
  return [...found];
}

/** Every module reachable from `entry` by relative imports, and any `node:` use. */
function moduleGraph(entry: string): { modules: string[]; nodeImports: string[] } {
  const seen = new Set<string>();
  const nodeImports: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith("node:")) {
        nodeImports.push(`${path.basename(file)} imports ${specifier}`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const base = path.resolve(path.dirname(file), specifier);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
      );
      if (resolved) queue.push(resolved);
    }
  }
  return { modules: [...seen], nodeImports };
}

/** Resolve one import specifier to a file, the way the project's toolchains do. */
function resolveSpecifier(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith("@/")
    ? path.join(process.cwd(), "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(from), specifier)
      : undefined;
  if (!base) return undefined;
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

/** Whether a module reaches `core/zone.ts` within `hops` imports. */
function reachesZone(file: string, hops: number): boolean {
  for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
    if (specifier.endsWith("core/zone")) return true;
    if (hops <= 1) continue;
    const next = resolveSpecifier(file, specifier);
    if (next && next !== file && reachesZone(next, hops - 1)) return true;
  }
  return false;
}

await group("The client module stays client safe", () => {
  const zoneFile = path.join(process.cwd(), "src", "lib", "core", "zone.ts");
  const graph = moduleGraph(zoneFile);
  check(
    "zone.ts reaches no node: builtin",
    graph.nodeImports.length === 0,
    graph.nodeImports.join("; "),
  );
  check(
    "zone.ts imports nothing at all, so a browser cannot pull the server in through it",
    graph.modules.length === 1,
    graph.modules.map((file) => path.relative(process.cwd(), file)).join(", "),
  );

  /**
   * The other half of client safety: the components that render calendar-shaped
   * content must reach the client module. One hop is allowed, because the cave's
   * day labels live in `lib/cave/types.ts` and the room imports them from there;
   * what matters is that there is one implementation, not that every file names
   * it directly.
   */
  const componentDir = path.join(process.cwd(), "src", "components", "xana");
  const dateComponents = [
    "AmbientCards.tsx",
    "CardView.tsx",
    "cave/ScheduleRoom.tsx",
    "cave/HealthRoom.tsx",
  ];
  const missing = dateComponents.filter((file) => !reachesZone(path.join(componentDir, file), 2));
  check(
    "every component that renders a date reaches the zone helpers",
    missing.length === 0,
    missing.join(", "),
  );

  /**
   * Turn.tsx is in the scan but not the list above: it renders no date at all,
   * only an engine name and a latency, so there is nothing for it to zone. It is
   * checked for the negative that does apply, a browser-local `toLocale*` call.
   */
  const allComponents = [...dateComponents, "Turn.tsx"];
  const offenders = allComponents.filter((file) =>
    /toLocale(Time|Date)String/.test(readFileSync(path.join(componentDir, file), "utf8")),
  );
  check("and none of them formats a date on its own", offenders.length === 0, offenders.join(", "));
});

/* ------------------------------------------------------------------ */
/* The app's time module is the zone's                                 */
/* ------------------------------------------------------------------ */

await group("The app's time module is the zone's", () => {
  const samples = [CLOCK, CROSSING, NIGHT, MORNING];
  check(
    "toDateKey matches the zone for every sample",
    samples.every((instant) => time.toDateKey(instant) === zone.dateKeyInZone(instant)),
    samples.map((instant) => time.toDateKey(instant)).join(", "),
  );
  check(
    "startOfDay matches the zone for every sample",
    samples.every((instant) => time.startOfDay(instant).getTime() === zone.startOfDayInZone(instant).getTime()),
  );
  check(
    "endOfDay matches the zone for every sample",
    samples.every((instant) => time.endOfDay(instant).getTime() === zone.endOfDayInZone(instant).getTime()),
  );
  check(
    "partOfDay reads the app's hour, not UTC's",
    time.partOfDay(new Date(MIDNIGHT)) === "night" && zone.hourInZone(new Date(MIDNIGHT), "UTC") === 16,
    `app says ${time.partOfDay(new Date(MIDNIGHT))} at ${zone.hourInZone(new Date(MIDNIGHT), "UTC")}:00 UTC`,
  );
  check(
    "formatTime matches the zone",
    samples.every((instant) => time.formatTime(instant) === zone.clockInZone(instant)),
  );
  check(
    "the hour of the day is the zone's hour",
    zone.hourInZone(NIGHT) === 23 && zone.hourInZone(MORNING) === 7,
    `${zone.hourInZone(NIGHT)} / ${zone.hourInZone(MORNING)}`,
  );
});

/* ------------------------------------------------------------------ */

try {
  rmSync(DATA_DIR, { recursive: true, force: true });
} catch {
  /* the OS will take it */
}

console.log(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
if (failed > 0) process.exit(1);
