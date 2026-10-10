/**
 * The calendar: its arithmetic, its window, and what a drag sends.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-calendar.ts
 *
 * WHY THIS FILE EXISTS
 *
 * A calendar is arithmetic with no visible failure mode. A month grid that
 * starts on the wrong weekday looks like a month. Two overlapping meetings that
 * both claim the full width look like two meetings. A drag that is one quarter
 * hour out looks like the hand shook. None of that is visible in a screenshot
 * and none of it throws, which is exactly the class of bug a check earns its
 * place by catching.
 *
 * WHAT IS BEING CHECKED
 *
 *  1. **The grid.** 42 days, Monday first, for months that start on every
 *     weekday — including the one that needs six rows.
 *  2. **Paging.** Forward and back must not walk: 31 January plus a month is
 *     28 February, and the month after that is March, not the 3rd of March.
 *  3. **Placement.** An event that starts before midnight and ends after it
 *     belongs to both days, clamped, and says so. A zero-length row is still
 *     drawn at a quarter hour so it can be pressed.
 *  4. **Overlap.** Two meetings at two o'clock are each half as wide; three are
 *     each a third; a fourth at four o'clock is full width again because the
 *     cluster closed. This is the algorithm with the most ways to be subtly
 *     wrong and the least evidence when it is.
 *  5. **The drop.** What a drag actually sends: the minutes, the length, and —
 *     for an all-day entry — the day alone, because a chip has no clock to move.
 *  6. **The window, through the real operation.** An event at 23:59 on the last
 *     day is in; one at 00:00 the next day is out; one that began the day before
 *     and runs into the window is in. And the days are the *app's* days, which
 *     is the whole reason the operation takes days rather than instants.
 *
 * ISOLATION
 *
 * `XANA_DATA_DIR` is moved to a temp directory before the store is imported, and
 * a settings file is written immediately, because the store migrates
 * `<cwd>/.xana/settings.json` into the data dir when the target is missing —
 * which would MOVE a real file out of the user's project. Same guard as
 * `check-task-edit.ts`, for the same reason.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "xana-calendar-"));
process.env.XANA_DATA_DIR = DATA_DIR;
writeFileSync(path.join(DATA_DIR, "settings.json"), "{}\n", { encoding: "utf8", mode: 0o600 });

const { getStore, closeStore } = await import("../src/lib/core/store");
const { runCaveOperation } = await import("../src/lib/cave/ops");
const zone = await import("../src/lib/core/zone");
const geometry = await import("../src/lib/calendar/geometry");
const pointerDrag = await import("../src/components/xana/cave/calendar/pointerDrag");
const swipe = await import("../src/components/xana/cave/calendar/useSwipePage");

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function group(title: string, run: () => void): void {
  console.log(`\n${title}\n`);
  try {
    run();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${title} threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The same, for a group that has to wait for a timer. */
async function groupAsync(title: string, run: () => Promise<void>): Promise<void> {
  console.log(`\n${title}\n`);
  try {
    await run();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${title} threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Run an operation, capturing a `CaveError` instead of throwing. */
function attempt(
  op: Parameters<typeof runCaveOperation>[0],
  input: Record<string, unknown>,
): { ok: boolean; message: string; status: number; payload: ReturnType<typeof runCaveOperation> | undefined } {
  try {
    return { ok: true, message: "", status: 200, payload: runCaveOperation(op, input) };
  } catch (err) {
    const e = err as { message?: string; status?: number };
    return { ok: false, message: e.message ?? String(err), status: e.status ?? 500, payload: undefined };
  }
}

const store = getStore();

/** An instant on a day, at a minute, in the app's zone. */
const at = (dayKey: string, minutes: number): string =>
  geometry.instantFor(dayKey, minutes).toISOString();

/** A record built by hand, for the pure functions that just read one. */
function record(id: string, dayKey: string, startMin: number, minutes: number, title = id) {
  return {
    id,
    title,
    start: at(dayKey, startMin),
    end: at(dayKey, startMin + minutes),
    source: "user",
  };
}

/* ------------------------------------------------------------------ */
/* 1. The grid                                                         */
/* ------------------------------------------------------------------ */

group("The month grid is six whole weeks, Monday first", () => {
  const days = geometry.monthGridDays("2026-10-15");
  check("it is 42 days", days.length === 42, String(days.length));
  check("it starts on a Monday", geometry.weekdayIndex(days[0]) === 0, days[0]);
  check("it ends on a Sunday", geometry.weekdayIndex(days[41]) === 6, days[41]);
  check("it contains the first of the month", days.includes("2026-10-01"));
  check("it contains the last", days.includes("2026-10-31"));
  // Every day of the month, not just its ends: a grid built by counting from the
  // wrong Monday holds October but is Missing the 30th or shows it twice.
  const inOctober = days.filter((day) => day.startsWith("2026-10"));
  check("and every day of the month exactly once", inOctober.length === 31 && new Set(inOctober).size === 31, String(inOctober.length));
  check("no day appears twice", new Set(days).size === 42, String(new Set(days).size));

  // A month that starts on a Monday: no leading days at all, and the grid still
  // has to hold the whole month plus the tail of the next one.
  const june = geometry.monthGridDays("2026-06-10");
  check("a month starting on a Monday starts the grid on its own 1st", june[0] === "2026-06-01", june[0]);

  // And one that starts on a Sunday, which is the six-row case.
  const february = geometry.monthGridDays("2026-02-10");
  check("February 2026 starts its grid in January", february[0] === "2026-01-26", february[0]);
  check("and still ends on a Sunday", geometry.weekdayIndex(february[41]) === 6, february[41]);
});

group("A week is Monday to Sunday", () => {
  const days = geometry.weekDays("2026-10-03"); // a Saturday
  check("seven days", days.length === 7, String(days.length));
  check("starting on the Monday before it", days[0] === "2026-09-28", days[0]);
  check("and ending on the Sunday after it", days[6] === "2026-10-04", days[6]);
  check("which contains the day asked for", days.includes("2026-10-03"));
});

group("Paging a month does not walk", () => {
  check("31 January plus a month is the end of February", geometry.addMonths("2026-01-31", 1) === "2026-02-28");
  check("and the month after that is March", geometry.addMonths("2026-02-28", 1) === "2026-03-28");
  check("a leap February keeps its 29th", geometry.addMonths("2028-01-31", 1) === "2028-02-29");
  check("December rolls the year", geometry.addMonths("2026-12-15", 1) === "2027-01-15");
  check("and back", geometry.addMonths("2027-01-15", -1) === "2026-12-15");
  check("a week is seven days", geometry.shiftAnchor("week", "2026-10-03", 1) === "2026-10-10");
  check("a day is one", geometry.shiftAnchor("day", "2026-10-03", -1) === "2026-10-02");
});

group("A view asks for the days it draws", () => {
  const month = geometry.windowFor("month", "2026-10-15");
  check("a month asks for 42 days", month.days === 42, String(month.days));
  check("from the Monday of the first week", month.from === "2026-09-28", month.from);
  check("to the Sunday of the last", month.to === "2026-11-08", month.to);

  const week = geometry.windowFor("week", "2026-10-03");
  check("a week asks for 7", week.days === 7, String(week.days));
  check("starting Monday", week.from === "2026-09-28", week.from);

  const day = geometry.windowFor("day", "2026-10-03");
  check("a day asks for one", day.days === 1 && day.from === "2026-10-03" && day.to === "2026-10-03");
});

/* ------------------------------------------------------------------ */
/* 2. Clock readings                                                   */
/* ------------------------------------------------------------------ */

group("Minutes and clocks", () => {
  check("09:05 is 545 minutes", geometry.parseClock("09:05") === 545, String(geometry.parseClock("09:05")));
  check("00:00 is zero", geometry.parseClock("00:00") === 0);
  check("a 25th hour is refused", geometry.parseClock("25:00") === null);
  check("half four is refused", geometry.parseClock("half four") === null);
  check("545 formats back", geometry.formatClock(545) === "09:05", geometry.formatClock(545));
  check("midnight formats as 00:00", geometry.formatClock(0) === "00:00");
  check("and a day wraps rather than printing 24:xx", geometry.formatClock(24 * 60) === "00:00");
  check("round trip", geometry.formatClock(geometry.parseClock("23:45") ?? 0) === "23:45");
});

group("Snapping", () => {
  check("seven minutes past snaps down", geometry.snap(547) === 540, String(geometry.snap(547)));
  check("eight past snaps up", geometry.snap(548) === 555, String(geometry.snap(548)));
  check("exactly on the quarter does not move", geometry.snap(555) === 555);
  check("the slot is a quarter hour", geometry.SLOT_MINUTES === 15, String(geometry.SLOT_MINUTES));
});

group("The app's day is 24 hours and its own", () => {
  check("a Shanghai day is 1440 minutes", geometry.dayLength("2026-10-03") === 1440, String(geometry.dayLength("2026-10-03")));
  check(
    "and a date key's instant is that day's midnight in the app's zone",
    zone.hourInZone(geometry.instantFor("2026-10-03", 0)) === 0 &&
      zone.dateKeyInZone(geometry.instantFor("2026-10-03", 0)) === "2026-10-03",
  );
  check(
    "the clock label is the clock, whatever the reader's locale",
    geometry.clockLabel("2026-10-03", 14 * 60).length > 0 &&
      geometry.clockLabel("2026-10-03", 0) !== geometry.clockLabel("2026-10-03", 14 * 60),
    geometry.clockLabel("2026-10-03", 14 * 60),
  );
  check("a month has a name", /2026/.test(zone.monthYearInZone(geometry.instantFor("2026-10-03", 0))), zone.monthYearInZone(geometry.instantFor("2026-10-03", 0)));
});

/* ------------------------------------------------------------------ */
/* 3. Placement                                                        */
/* ------------------------------------------------------------------ */

group("An event is placed from its own instants", () => {
  const day = "2026-10-06";
  const events = [record("a", day, 9 * 60, 60), record("b", day, 13 * 60 + 30, 45)];

  const placed = geometry.eventsForDay(events, day);
  check("both are drawn", placed.length === 2, String(placed.length));
  check("the first starts at 540 minutes", placed[0]?.startMin === 540, String(placed[0]?.startMin));
  check("and ends at 600", placed[0]?.endMin === 600, String(placed[0]?.endMin));
  check("the second is at 13:30", placed[1]?.startMin === 810, String(placed[1]?.startMin));
  check("neither claims to continue", placed.every((entry) => !entry.continuesBefore && !entry.continuesAfter));

  const tomorrow = geometry.eventsForDay(events, "2026-10-07");
  check("a day with nothing on it draws nothing", tomorrow.length === 0, String(tomorrow.length));
});

group("An event that crosses midnight belongs to both days, clamped", () => {
  const start = at("2026-10-06", 23 * 60);
  const end = at("2026-10-07", 1 * 60);
  const overnight = { id: "night", title: "Deploy", start, end, source: "user" };

  const first = geometry.eventsForDay([overnight], "2026-10-06")[0];
  check("it is on the day it starts", Boolean(first));
  check("from 23:00", first?.startMin === 1380, String(first?.startMin));
  check("to the end of the day", first?.endMin === 1440, String(first?.endMin));
  check("and it says it continues", first?.continuesAfter === true);
  check("but not that it began earlier", first?.continuesBefore === false);

  const second = geometry.eventsForDay([overnight], "2026-10-07")[0];
  check("it is on the next day too", Boolean(second));
  check("from midnight", second?.startMin === 0, String(second?.startMin));
  check("to 01:00", second?.endMin === 60, String(second?.endMin));
  check("saying it began before", second?.continuesBefore === true);
  check("and does not continue after", second?.continuesAfter === false);

  const later = geometry.eventsForDay([overnight], "2026-10-08");
  check("and on no other day at all", later.length === 0, String(later.length));
});

group("A zero-length row is still a target", () => {
  const day = "2026-10-06";
  const broken = { id: "zero", title: "Typo", start: at(day, 600), end: at(day, 600), source: "user" };
  const placed = geometry.eventsForDay([broken], day)[0];
  check("it is drawn", Boolean(placed));
  check("at no less than a quarter hour", geometry.blockMinutes(placed) === geometry.SLOT_MINUTES, String(geometry.blockMinutes(placed)));
});

group("An all-day entry is not a block", () => {
  const day = "2026-10-06";
  const holiday = {
    id: "holiday",
    title: "Holiday",
    start: at(day, 0),
    end: at("2026-10-07", 0),
    source: "ics",
    allDay: true,
  };
  check("it is in the all-day lane", geometry.allDayForDay([holiday], day).length === 1);
  check("and not in the hours", geometry.eventsForDay([holiday], day).length === 0);
  check("it is recognised as all-day", geometry.isAllDay(holiday));
  check("it does not touch the day before", geometry.allDayForDay([holiday], "2026-10-05").length === 0);
  check("nor the day after", geometry.allDayForDay([holiday], "2026-10-07").length === 0);
});

/* ------------------------------------------------------------------ */
/* 4. Overlap                                                          */
/* ------------------------------------------------------------------ */

group("Overlapping entries share the width", () => {
  const day = "2026-10-06";

  const pair = geometry.eventsForDay(
    [record("a", day, 14 * 60, 60), record("b", day, 14 * 60 + 30, 60)],
    day,
  );
  check("two overlapping entries are two columns", pair.every((entry) => entry.columns === 2), JSON.stringify(pair.map((e) => e.columns)));
  check("in different columns", pair[0]?.column !== pair[1]?.column, JSON.stringify(pair.map((e) => e.column)));

  const triple = geometry.eventsForDay(
    [record("a", day, 14 * 60, 90), record("b", day, 14 * 60 + 30, 90), record("c", day, 15 * 60, 30)],
    day,
  );
  check("three at once are three columns", triple.every((entry) => entry.columns === 3), JSON.stringify(triple.map((e) => e.columns)));
  check("each in its own", new Set(triple.map((entry) => entry.column)).size === 3, JSON.stringify(triple.map((e) => e.column)));

  const apart = geometry.eventsForDay(
    [record("a", day, 9 * 60, 60), record("b", day, 11 * 60, 60)],
    day,
  );
  check("entries that do not touch are full width", apart.every((entry) => entry.columns === 1));

  // The transitive case: the morning meeting and the lunch one never overlap,
  // but the one between them touches both, so all three are one cluster — and
  // the first two must not be drawn full width and then jump when the third
  // arrives.
  const chain = geometry.eventsForDay(
    [record("a", day, 9 * 60, 60), record("b", day, 9 * 60 + 30, 60), record("c", day, 10 * 60, 60)],
    day,
  );
  check("a chain of three is one cluster of two columns", chain.every((entry) => entry.columns === 2), JSON.stringify(chain.map((e) => e.columns)));
  check("with the first and the third in the same column", chain[0]?.column === chain[2]?.column, JSON.stringify(chain.map((e) => e.column)));

  const recovered = geometry.eventsForDay(
    [record("a", day, 9 * 60, 60), record("b", day, 9 * 60 + 30, 60), record("c", day, 16 * 60, 30)],
    day,
  );
  check("and the cluster closes", recovered[2]?.columns === 1, String(recovered[2]?.columns));
});

group("Overlap is decided by the day, not by the row order", () => {
  const day = "2026-10-06";
  const forwards = geometry.eventsForDay(
    [record("a", day, 900, 60), record("b", day, 840, 60), record("c", day, 960, 60)],
    day,
  );
  check("the earliest is drawn first", forwards[0]?.event.id === "b", String(forwards[0]?.event.id));
  check("then the middle", forwards[1]?.event.id === "a", String(forwards[1]?.event.id));
  check("then the last", forwards[2]?.event.id === "c", String(forwards[2]?.event.id));
});

/* ------------------------------------------------------------------ */
/* 4b. The whole-grid pass, against the per-day read                    */
/* ------------------------------------------------------------------ */

group("The whole-grid pass agrees with the per-day read", () => {
  const day = "2026-10-06";
  const days = geometry.monthGridDays("2026-10-15");
  const events = [
    record("a", day, 9 * 60, 60),
    record("b", day, 9 * 60 + 30, 60),
    { id: "night", title: "Deploy", start: at(day, 23 * 60), end: at("2026-10-07", 60), source: "user" },
    { id: "holiday", title: "Holiday", start: at(day, 0), end: at("2026-10-07", 0), source: "ics", allDay: true },
    {
      id: "long",
      title: "Conference",
      start: at("2026-10-04", 9 * 60),
      end: at("2026-10-09", 17 * 60),
      source: "user",
    },
    { id: "outside", title: "Elsewhere", start: at("2026-12-01", 9 * 60), end: at("2026-12-01", 10 * 60), source: "user" },
  ];

  const buckets = geometry.bucketDays(events, days);
  check("every day of the grid is in the map", buckets.size === 42, String(buckets.size));

  // The bucketed path and the per-day path are two ways to ask one question, so
  // they are compared on every field the grid draws with. A divergence here is
  // a block that sits at a different height depending on which code path drew
  // it, which is exactly the kind of bug this check exists to make impossible.
  let mismatches = 0;
  let compared = 0;
  for (const key of days) {
    const bucket = buckets.get(key);
    const single = geometry.eventsForDay(events, key);
    const singleAllDay = geometry.allDayForDay(events, key);
    if (!bucket) {
      mismatches += 1;
      continue;
    }
    if (bucket.timed.length !== single.length) mismatches += 1;
    if (bucket.allDay.length !== singleAllDay.length) mismatches += 1;
    single.forEach((entry, index) => {
      const other = bucket.timed[index];
      compared += 1;
      if (
        !other ||
        other.event.id !== entry.event.id ||
        other.startMin !== entry.startMin ||
        other.endMin !== entry.endMin ||
        other.column !== entry.column ||
        other.columns !== entry.columns ||
        other.continuesBefore !== entry.continuesBefore ||
        other.continuesAfter !== entry.continuesAfter
      ) {
        mismatches += 1;
      }
    });
  }
  check("42 days compared, no disagreement", mismatches === 0 && compared > 0, `${mismatches} of ${compared}`);

  const night = buckets.get("2026-10-07")?.timed.find((entry) => entry.event.id === "night");
  check("an entry that crosses midnight is clamped on the far side", night?.startMin === 0 && night?.endMin === 60, `${night?.startMin}–${night?.endMin}`);
  check("and says it began earlier", night?.continuesBefore === true);

  const long = days.filter((key) => (buckets.get(key)?.timed ?? []).some((entry) => entry.event.id === "long"));
  // 09:00 on the 4th to 17:00 on the 9th is six calendar days, not five: the
  // first assertion here was wrong when it was written, and the check caught it.
  check("a five-day-long entry is placed on all six days it touches", long.length === 6, String(long.length));
  const firstDay = buckets.get("2026-10-04")?.timed.find((entry) => entry.event.id === "long");
  check(
    "on its first day it starts where it starts, unclamped",
    firstDay?.startMin === 540 && firstDay?.continuesBefore === false,
    `${firstDay?.startMin} before=${firstDay?.continuesBefore}`,
  );
  const lastDay = buckets.get("2026-10-09")?.timed.find((entry) => entry.event.id === "long");
  check("and on its last it ends where it ends", lastDay?.endMin === 1020 && lastDay?.continuesAfter === false, `${lastDay?.endMin} after=${lastDay?.continuesAfter}`);

  // The clamp in the other direction: an entry that began before the grid.
  const straddling = geometry.bucketDays(
    [{ id: "early", title: "Early", start: at("2026-09-20", 9 * 60), end: at("2026-10-02", 12 * 60), source: "user" }],
    days,
  );
  const firstVisible = straddling.get("2026-09-28")?.timed[0];
  check(
    "an entry that began before the grid is clamped to midnight and says so",
    firstVisible?.startMin === 0 && firstVisible.continuesBefore === true,
    `${firstVisible?.startMin} before=${firstVisible?.continuesBefore}`,
  );

  check(
    "an entry outside the window lands nowhere",
    !days.some((key) => (buckets.get(key)?.timed ?? []).some((entry) => entry.event.id === "outside")),
  );
  check(
    "the all-day entry is in the lane, not the hours",
    (buckets.get(day)?.allDay ?? []).some((event) => event.id === "holiday") &&
      !(buckets.get(day)?.timed ?? []).some((entry) => entry.event.id === "holiday"),
  );

  const bounds = buckets.get(day);
  check("a day's own bounds are the app's midnights", bounds?.minutes === 1440, String(bounds?.minutes));
  check(
    "and they match the zone helpers directly",
    bounds?.start === zone.fromDateKeyInZone(day).getTime(),
    `${bounds?.start} vs ${zone.fromDateKeyInZone(day).getTime()}`,
  );
  check("an empty grid is an empty map rather than a throw", geometry.bucketDays(events, []).size === 0);
});

/* ------------------------------------------------------------------ */
/* 5. What a drag means                                                */
/* ------------------------------------------------------------------ */

group("A drop is computed from the pointer, not from the top of the block", () => {
  check("a grab at the block's top drops where the pointer is", geometry.dropMinutes(600, 0, 60) === 600);
  check("a grab half way down keeps the block under the hand", geometry.dropMinutes(600, 30, 60) === 570);
  check("and it snaps to the quarter", geometry.dropMinutes(602, 0, 60) === 600, String(geometry.dropMinutes(602, 0, 60)));
  check("a block dragged off the bottom stops at the bottom", geometry.dropMinutes(1500, 0, 60) === 1380, String(geometry.dropMinutes(1500, 0, 60)));
  check("a block dragged above the day stops at midnight", geometry.dropMinutes(-30, 0, 60) === 0);
});

group("The patch a move sends", () => {
  const day = "2026-10-06";
  const timed = record("a", day, 9 * 60, 45);
  const move = geometry.movePatch(timed, "2026-10-08", 14 * 60);
  check("it names the new day", move.date === "2026-10-08", String(move.date));
  check("the new clock", move.time === "14:00", String(move.time));
  check("and keeps the length", move.minutes === 45, String(move.minutes));

  const allDay = { ...record("b", day, 0, 60), allDay: true };
  const chip = geometry.movePatch(allDay, "2026-10-09", 0);
  check("an all-day entry sends the day alone", chip.date === "2026-10-09" && chip.time === undefined && chip.minutes === undefined, JSON.stringify(chip));

  const resized = geometry.resizePatch(timed, day, 9 * 60, 90);
  check("a resize sends the new length", resized.minutes === 90, String(resized.minutes));
  check("and never less than a slot", geometry.resizePatch(timed, day, 540, 1).minutes === geometry.SLOT_MINUTES);
  check("nor more than half a day", geometry.resizePatch(timed, day, 540, 5000).minutes === geometry.MAX_MINUTES, String(geometry.resizePatch(timed, day, 540, 5000).minutes));
});

group("Pointer to day and minute", () => {
  const columns = [
    { key: "a", left: 100, width: 100 },
    { key: "b", left: 200, width: 100 },
    { key: "c", left: 300, width: 100 },
  ];
  check("inside the first", geometry.columnAt(150, columns) === "a");
  check("inside the last", geometry.columnAt(350, columns) === "c");
  check("left of the grid is still the first day", geometry.columnAt(10, columns) === "a");
  check("right of it is still the last", geometry.columnAt(900, columns) === "c");
  check("midnight is the top of the body", geometry.minutesAt(200, 200, 0, 56) === 0);
  check("an hour down is sixty minutes", geometry.minutesAt(256, 200, 0, 56) === 60);
  check("and a scrolled grid adds its scroll", geometry.minutesAt(256, 200, 56, 56) === 120);
});

group("Where a quick-add lands", () => {
  const day = "2026-10-06";
  const events = [record("a", day, 9 * 60, 60)];
  check("an empty hour is untouched", geometry.nextFreeStart(events, day, 11 * 60) === 660, String(geometry.nextFreeStart(events, day, 11 * 60)));
  check("a taken hour is skipped", geometry.nextFreeStart(events, day, 9 * 60 + 15) === 600, String(geometry.nextFreeStart(events, day, 9 * 60 + 15)));
  check("and a clash later in the day does not move it", geometry.nextFreeStart(events, day, 14 * 60) === 840, String(geometry.nextFreeStart(events, day, 14 * 60)));
});

/* ------------------------------------------------------------------ */
/* 6. The window, through the real operation                           */
/* ------------------------------------------------------------------ */

group("The window is closed at both ends, by day", () => {
  const day = "2026-11-10";

  const before = attempt("event.create", { title: "late", date: day, time: "23:59", minutes: 1 });
  const after = attempt("event.create", { title: "early", date: "2026-11-11", time: "00:00", minutes: 30 });
  const inside = attempt("event.create", { title: "inside", date: "2026-11-10", time: "09:00", minutes: 60 });
  check("three entries are created", before.ok && after.ok && inside.ok, `${before.message} ${after.message} ${inside.message}`);

  const answer = attempt("event.range", { from: day, to: day });
  check("the read is accepted", answer.ok, answer.message);
  const events = answer.payload?.range?.events ?? [];
  const titles = events.map((event) => event.title);

  check("23:59 on the last day is in", titles.includes("late"), titles.join(","));
  check("09:00 on it is in", titles.includes("inside"));
  check("00:00 the next day is out", !titles.includes("early"), titles.join(","));
  check("the window says how many days it is", answer.payload?.range?.days === 1, String(answer.payload?.range?.days));
  check("and names both ends of it", answer.payload?.range?.from === day && answer.payload?.range?.to === day);
  check(
    "the instants are the app's midnights",
    zone.hourInZone(new Date(answer.payload?.range?.start ?? 0)) === 0 &&
      zone.dateKeyInZone(new Date(answer.payload?.range?.start ?? 0)) === day,
    String(answer.payload?.range?.start),
  );

  const wide = attempt("event.range", { from: "2026-11-01", to: "2026-11-30" });
  check("a wider window finds them all", (wide.payload?.range?.events ?? []).length >= 3, String((wide.payload?.range?.events ?? []).length));
});

group("An entry that began before the window is still in it", () => {
  const overnight = store.createEvent({
    title: "overnight",
    start: at("2026-12-01", 22 * 60),
    end: at("2026-12-02", 2 * 60),
    source: "user",
    allDay: false,
  });
  const answer = attempt("event.range", { from: "2026-12-02", to: "2026-12-02" });
  const events = answer.payload?.range?.events ?? [];
  check("the window that only holds its second half finds it", events.some((event) => event.id === overnight.id), events.map((e) => e.title).join(","));
  const placed = geometry.eventsForDay(events, "2026-12-02")[0];
  check("and it is drawn from midnight to two", placed?.startMin === 0 && placed?.endMin === 120, `${placed?.startMin}–${placed?.endMin}`);
  check("saying that it began earlier", placed?.continuesBefore === true);
});

group("An all-day entry is written as a day, not a moment", () => {
  const created = attempt("event.create", { title: "holiday", date: "2027-04-05", allDay: true, time: "17:00" });
  check("it is created", created.ok, created.message);
  const event = created.payload?.event;
  check("it is marked all day", event?.allDay === true);
  check("it starts at that day's midnight", zone.dateKeyInZone(new Date(event?.start ?? 0)) === "2027-04-05" && zone.hourInZone(new Date(event?.start ?? 0)) === 0, String(event?.start));
  check("and ends at the next day's", zone.dateKeyInZone(new Date(event?.end ?? 0)) === "2027-04-06" && zone.hourInZone(new Date(event?.end ?? 0)) === 0, String(event?.end));

  const back = attempt("event.update", { id: event?.id, allDay: false });
  check("un-ticking it is accepted", back.ok, back.message);
  check("and it lands at the hour a new entry would get", zone.hourMinuteInZone(new Date(back.payload?.event?.start ?? 0)) === "09:00", String(back.payload?.event?.start));
  check("with an hour in it", new Date(back.payload?.event?.end ?? 0).getTime() - new Date(back.payload?.event?.start ?? 0).getTime() === 60 * 60_000);
});

group("Moving by day alone keeps the clock", () => {
  const created = attempt("event.create", { title: "seminar", date: "2027-05-04", time: "16:30", minutes: 90 });
  const id = created.payload?.event?.id;
  check("it is created", created.ok && Boolean(id), created.message);

  const moved = attempt("event.update", { id, date: "2027-05-06" });
  check("the move is accepted", moved.ok, moved.message);
  check("it is on the new day", zone.dateKeyInZone(new Date(moved.payload?.event?.start ?? 0)) === "2027-05-06", String(moved.payload?.event?.start));
  check("at the same clock", zone.hourMinuteInZone(new Date(moved.payload?.event?.start ?? 0)) === "16:30", String(moved.payload?.event?.start));
  check(
    "for the same ninety minutes",
    new Date(moved.payload?.event?.end ?? 0).getTime() - new Date(moved.payload?.event?.start ?? 0).getTime() === 90 * 60_000,
  );

  const removed = attempt("event.delete", { id });
  check("and removing it is accepted", removed.ok, removed.message);
  const after = attempt("event.range", { from: "2027-05-01", to: "2027-05-31" });
  check("it is gone from the window", !(after.payload?.range?.events ?? []).some((event) => event.id === id));
});

group("A window it cannot read is refused", () => {
  const junk = attempt("event.range", { from: "next tuesday", to: "2027-05-31" });
  check("junk is refused", !junk.ok, JSON.stringify(junk));
  check("as a 400", junk.status === 400, String(junk.status));
  check("with the shape it wants", /YYYY-MM-DD/.test(junk.message), junk.message);

  check("a missing end is refused", !attempt("event.range", { from: "2027-05-01" }).ok);
  check("a backwards window is refused", !attempt("event.range", { from: "2027-05-31", to: "2027-05-01" }).ok);
  check("and an absurd one is refused rather than read", !attempt("event.range", { from: "1000-01-01", to: "3000-01-01" }).ok);
  check(
    "a year is still allowed",
    attempt("event.range", { from: "2027-01-01", to: "2027-12-31" }).ok,
  );
});

/* ------------------------------------------------------------------ */
/* 7. The gesture itself, without a browser                             */
/* ------------------------------------------------------------------ */

/**
 * WHY THIS HALF OF THE CHECK EXISTS, AND WHY IT IS SHAPED LIKE THIS
 *
 * The gesture engine is the part of the calendar with the least evidence when
 * it is wrong: a drag that never commits, a listener that is never removed, an
 * Escape that commits anyway. It has no server to complain and no arithmetic to
 * be visibly off — the only way to know is to drive it.
 *
 * A headless browser was the first choice and it is not available in this
 * environment: Chromium's browser process cannot open the named pipe its own
 * child processes need, so it dies before the DevTools endpoint answers. What is
 * left is the part that actually has the bugs — `beginPointerDrag` touches only
 * `window`, a timer, and an element that can capture a pointer — and all three
 * can be stood up in a few lines. So the engine is driven directly: press, move,
 * release, Escape, and a lost pointer, each asserted on the callbacks the
 * calendar's grids actually receive.
 */
group("The gesture engine, driven by hand", () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const fakeWindow = {
    addEventListener(type: string, fn: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
  };
  const fire = (type: string, event: Record<string, unknown>) => {
    for (const fn of [...(listeners.get(type) ?? [])]) {
      fn({ type, cancelable: true, preventDefault: () => {}, ...event });
    }
  };
  const pending: Array<() => void> = [];
  const flush = (times = 1) => {
    for (let i = 0; i < times; i += 1) {
      const batch = pending.splice(0, pending.length);
      for (const run of batch) run();
    }
  };

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = fakeWindow;
  globals.requestAnimationFrame = (fn: () => void) => {
    pending.push(fn);
    return pending.length;
  };
  globals.cancelAnimationFrame = () => {};

  const element = {
    captured: null as number | null,
    setPointerCapture(id: number) {
      this.captured = id;
    },
    hasPointerCapture(id: number) {
      return this.captured === id;
    },
    releasePointerCapture() {
      this.captured = null;
    },
    style: {} as Record<string, string>,
  };

  const start = (options: Record<string, unknown> = {}) => {
    const frames: Array<{ dx: number; dy: number; moved: boolean }> = [];
    const state = { ended: null as null | { dx: number; dy: number; moved: boolean }, cancelled: 0, armed: 0 };
    const stop = pointerDrag.beginPointerDrag({
      pointerId: 1,
      element: element as unknown as Element,
      originX: 100,
      originY: 100,
      touch: false,
      onFrame: (frame) => frames.push({ dx: frame.dx, dy: frame.dy, moved: frame.moved }),
      onEnd: (frame) => {
        state.ended = { dx: frame.dx, dy: frame.dy, moved: frame.moved };
      },
      onCancel: () => {
        state.cancelled += 1;
      },
      onArm: () => {
        state.armed += 1;
      },
      ...options,
    });
    return { frames, state, stop };
  };

  /* ---- a drag moves, and commits once ---- */
  listeners.clear();
  const drag = start();
  check("a mouse gesture arms immediately", drag.state.armed === 1, String(drag.state.armed));
  check("and captures the pointer", element.captured === 1, String(element.captured));
  fire("pointermove", { pointerId: 1, clientX: 160, clientY: 214 });
  flush();
  check("a frame is delivered with the distance travelled", drag.frames.at(-1)?.dx === 60 && drag.frames.at(-1)?.dy === 114, JSON.stringify(drag.frames.at(-1)));
  check("and it is a drag, not a click", drag.frames.at(-1)?.moved === true);
  fire("pointerup", { pointerId: 1, clientX: 160, clientY: 214 });
  check("releasing commits once", drag.state.ended !== null && drag.state.ended.dx === 60 && drag.state.ended.moved === true, JSON.stringify(drag.state.ended));
  check("and releases the capture", element.captured === null);
  check("with every listener removed", listeners.size === 0 || [...listeners.values()].every((set) => set.size === 0), JSON.stringify([...listeners].map(([type, set]) => `${type}:${set.size}`)));
  check("and no frame runs after the release", (() => { const before = drag.frames.length; flush(2); return drag.frames.length === before; })());

  /* ---- a press that never moves is a click ---- */
  const tap = start();
  fire("pointerup", { pointerId: 1, clientX: 101, clientY: 100 });
  check("a press that does not travel ends as unmoved", tap.state.ended?.moved === false, JSON.stringify(tap.state.ended));

  /* ---- Escape is a cancel ---- */
  const escaped = start();
  fire("pointermove", { pointerId: 1, clientX: 200, clientY: 100 });
  flush();
  fire("keydown", { key: "Escape" });
  check("Escape cancels", escaped.state.cancelled === 1, String(escaped.state.cancelled));
  check("and commits nothing", escaped.state.ended === null);
  check("and cleans up", [...listeners.values()].every((set) => set.size === 0));

  /* ---- a lost pointer is a cancel, never a drop ---- */
  const lost = start();
  fire("pointermove", { pointerId: 1, clientX: 300, clientY: 300 });
  flush();
  fire("pointercancel", { pointerId: 1 });
  check("a cancelled pointer does not commit", lost.state.ended === null);
  check("and is reported as a cancel", lost.state.cancelled === 1);

  /* ---- the wrong pointer id is ignored ---- */
  const other = start();
  fire("pointermove", { pointerId: 2, clientX: 900, clientY: 900 });
  flush();
  check("another pointer's movement is ignored", (other.frames.at(-1)?.dx ?? 0) === 0, JSON.stringify(other.frames.at(-1)));
  fire("pointerup", { pointerId: 2, clientX: 900, clientY: 900 });
  check("and its release does not end this gesture", other.state.ended === null);
  other.stop();
});

group("A touch has to be held before it is a drag", () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = {
    addEventListener(type: string, fn: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
  };
  globals.requestAnimationFrame = () => 0;
  globals.cancelAnimationFrame = () => {};

  const fire = (type: string, event: Record<string, unknown>) => {
    for (const fn of [...(listeners.get(type) ?? [])]) {
      fn({ type, cancelable: true, preventDefault: () => {}, ...event });
    }
  };
  const element = {
    captured: null as number | null,
    setPointerCapture(id: number) {
      this.captured = id;
    },
    hasPointerCapture(id: number) {
      return this.captured === id;
    },
    releasePointerCapture() {
      this.captured = null;
    },
    style: {} as Record<string, string>,
  };
  const state = { ended: 0, cancelled: 0 };
  pointerDrag.beginPointerDrag({
    pointerId: 7,
    element: element as unknown as Element,
    originX: 50,
    originY: 50,
    touch: true,
    holdMs: 5,
    onEnd: () => {
      state.ended += 1;
    },
    onCancel: () => {
      state.cancelled += 1;
    },
  });

  // A swipe before the hold is up belongs to the scroller, and must not be
  // reported as a cancelled drag — nothing was ever picked up.
  fire("pointermove", { pointerId: 7, clientX: 50, clientY: 140 });
  check("a swipe during the hold is abandoned", state.cancelled === 1 && state.ended === 0, JSON.stringify(state));
  check("and the surface was never captured", element.captured === null);
  check("and the listeners are gone", [...listeners.values()].every((set) => set.size === 0));
});

await groupAsync("A touch that is held becomes a drag", async () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = {
    addEventListener(type: string, fn: (event: unknown) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
  };
  globals.requestAnimationFrame = () => 0;
  globals.cancelAnimationFrame = () => {};

  const fire = (type: string, event: Record<string, unknown>) => {
    for (const fn of [...(listeners.get(type) ?? [])]) {
      fn({ type, cancelable: true, preventDefault: () => {}, ...event });
    }
  };
  const element = {
    captured: null as number | null,
    setPointerCapture(id: number) {
      this.captured = id;
    },
    hasPointerCapture(id: number) {
      return this.captured === id;
    },
    releasePointerCapture() {
      this.captured = null;
    },
    style: {} as Record<string, string>,
  };
  const seen: { dx: number; moved: boolean }[] = [];
  pointerDrag.beginPointerDrag({
    pointerId: 9,
    element: element as unknown as Element,
    originX: 50,
    originY: 50,
    touch: true,
    holdMs: 5,
    onEnd: (frame) => {
      seen.push({ dx: frame.dx, moved: frame.moved });
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  check("holding arms the gesture and captures the pointer", element.captured === 9, String(element.captured));
  fire("pointermove", { pointerId: 9, clientX: 90, clientY: 50 });
  fire("pointerup", { pointerId: 9, clientX: 90, clientY: 50 });
  const ended = seen[0];
  check(
    "and the release commits the drag",
    ended !== undefined && ended.dx === 40 && ended.moved === true,
    JSON.stringify(seen),
  );
});

await groupAsync("Every gesture ends exactly once, and says how", async () => {
  /**
   * The endings, which is where the reported bug lived.
   *
   * A caller draws its preview when the gesture arms and takes it down on
   * `onEnd` or `onCancel`, so any path that reaches neither leaves the preview
   * on screen for the rest of the session. That is exactly what happened: a
   * finger that lifted inside the hold window ended the gesture in silence, and
   * the slot it had drawn stayed lit. The contract is that no such path exists
   * — one of the two runs, once, whatever happens to the pointer.
   */
  const harness = (pointerId: number) => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.window = {
      addEventListener(type: string, fn: (event: unknown) => void) {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener(type: string, fn: (event: unknown) => void) {
        listeners.get(type)?.delete(fn);
      },
    };
    globals.requestAnimationFrame = () => 0;
    globals.cancelAnimationFrame = () => {};

    const fire = (type: string, event: Record<string, unknown> = {}) => {
      for (const fn of [...(listeners.get(type) ?? [])]) {
        fn({ type, cancelable: true, preventDefault: () => {}, ...event });
      }
    };
    const element = {
      captured: null as number | null,
      setPointerCapture(id: number) {
        this.captured = id;
      },
      hasPointerCapture(id: number) {
        return this.captured === id;
      },
      releasePointerCapture() {
        this.captured = null;
      },
      style: {} as Record<string, string>,
    };
    const state = { ended: 0, cancelled: 0, armed: 0 };
    const begin = (touch: boolean, holdMs = 5) =>
      pointerDrag.beginPointerDrag({
        pointerId,
        element: element as unknown as Element,
        originX: 50,
        originY: 50,
        touch,
        holdMs,
        onArm: () => {
          state.armed += 1;
        },
        onEnd: () => {
          state.ended += 1;
        },
        onCancel: () => {
          state.cancelled += 1;
        },
      });
    return { listeners, fire, element, state, begin };
  };

  const armed = async (touch: boolean, pointerId: number) => {
    const kit = harness(pointerId);
    kit.begin(touch);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return kit;
  };

  // The reported bug: a tap that never became a hold. It used to report
  // nothing at all, and whatever the surface had drawn stayed drawn.
  {
    const kit = harness(1);
    kit.begin(true);
    kit.fire("pointerup", { pointerId: 1, clientX: 50, clientY: 50 });
    check(
      "a finger that lifts inside the hold is reported as a cancel",
      kit.state.cancelled === 1 && kit.state.ended === 0 && kit.state.armed === 0,
      JSON.stringify(kit.state),
    );
    check("and it never armed, so nothing was drawn", kit.state.armed === 0);
    check("and every listener came off", [...kit.listeners.values()].every((set) => set.size === 0));
  }

  // The browser taking the gesture for a scroll. `pointercancel` can arrive
  // before any `pointermove`, so the cancel must not depend on one.
  {
    const kit = harness(2);
    kit.begin(true);
    kit.fire("pointercancel", { pointerId: 2 });
    check(
      "a cancelled pointer before the hold is a cancel too",
      kit.state.cancelled === 1 && kit.state.ended === 0,
      JSON.stringify(kit.state),
    );
  }

  // A window that loses focus mid-press: the pointerup is going somewhere else.
  {
    const kit = harness(3);
    kit.begin(true);
    kit.fire("blur");
    check("losing the window ends it as a cancel", kit.state.cancelled === 1 && kit.state.ended === 0, JSON.stringify(kit.state));
  }

  // Escape, which is the keyboard's way out of a drag in progress.
  {
    const kit = harness(4);
    kit.begin(false);
    kit.fire("keydown", { key: "Escape" });
    check("Escape cancels an armed gesture", kit.state.cancelled === 1 && kit.state.ended === 0, JSON.stringify(kit.state));
  }

  // The released function a component calls when it unmounts mid-drag.
  {
    const kit = harness(5);
    const release = kit.begin(false);
    release();
    check("an unmount cancels rather than commits", kit.state.cancelled === 1 && kit.state.ended === 0, JSON.stringify(kit.state));
  }

  {
    const kit = await armed(true, 6);
    check("holding arms exactly once", kit.state.armed === 1, JSON.stringify(kit.state));
    kit.fire("pointerup", { pointerId: 6, clientX: 50, clientY: 50 });
    check(
      "and the release of an armed gesture commits",
      kit.state.ended === 1 && kit.state.cancelled === 0,
      JSON.stringify(kit.state),
    );
    // Anything arriving late must find a finished gesture, not start a second
    // ending: two cleanups for one preview is how a block ends up dimmed twice
    // or a drop is sent twice.
    kit.fire("pointerup", { pointerId: 6, clientX: 50, clientY: 50 });
    kit.fire("pointercancel", { pointerId: 6 });
    kit.fire("keydown", { key: "Escape" });
    check(
      "and nothing that arrives afterwards ends it again",
      kit.state.ended === 1 && kit.state.cancelled === 0,
      JSON.stringify(kit.state),
    );
  }

  {
    const kit = await armed(true, 7);
    kit.element.style.opacity = "0.35";
    kit.fire("pointercancel", { pointerId: 7 });
    check(
      "a pointer the browser takes mid-drag cancels, it never drops",
      kit.state.cancelled === 1 && kit.state.ended === 0,
      JSON.stringify(kit.state),
    );
  }

  // A mouse never waits: there is no scroll to lose the press to.
  {
    const kit = harness(8);
    kit.begin(false);
    check("a mouse arms on the press", kit.state.armed === 1, JSON.stringify(kit.state));
    kit.fire("pointerup", { pointerId: 8, clientX: 60, clientY: 50 });
    check("and a mouse release ends it", kit.state.ended === 1 && kit.state.cancelled === 0, JSON.stringify(kit.state));
  }
});

group("A short block keeps a body to drag", () => {
  /**
   * The measurements this law comes from, taken in a browser at 390x844 with
   * touch emulation: a 30-minute block is 22px tall and the two grips were a
   * fixed 14px each, so they covered 28px of a 22px block. The body left for
   * the move gesture was **minus six pixels** — every press reached a resize
   * handle, and a very ordinary event could be made longer but never moved.
   */
  const phone = geometry.hourHeightFor(true);
  const desktop = geometry.hourHeightFor(false);
  const box = (minutes: number, hour: number) => (minutes / 60) * hour;
  const body = (height: number, coarse: boolean) => height - 2 * geometry.gripHeightFor(height, coarse);

  check("a phone hour is the short one", phone === 44, String(phone));
  check("a desktop hour is the tall one", desktop === 56, String(desktop));

  const short = box(30, phone);
  check("a 30-minute block on a phone is 22px", Math.round(short) === 22, String(short));
  check(
    "so it is given no grips at all, and the whole block moves",
    geometry.gripHeightFor(short, true) === 0,
    String(geometry.gripHeightFor(short, true)),
  );
  check(
    "which is the bug, stated as a number: the fixed grip left a negative body",
    Math.round(short - 2 * 14) < 0 && Math.round(body(short, true)) === 22,
    `${short} - 28 = ${short - 28}`,
  );

  const hour = box(60, phone);
  const hourGrip = geometry.gripHeightFor(hour, true);
  check("an hour on a phone keeps grips", hourGrip > 0, String(hourGrip));
  check("and still leaves a body", body(hour, true) >= geometry.GRIP_BODY_COARSE, String(body(hour, true)));

  const long = box(120, phone);
  check(
    "a two-hour block is capped rather than given a third of itself",
    geometry.gripHeightFor(long, true) === geometry.GRIP_MAX_COARSE,
    String(geometry.gripHeightFor(long, true)),
  );

  // The case that already worked, pinned so the fix cannot cost the mouse
  // anything: a 30-minute block at 56px per hour had 12px of body and keeps it.
  const deskShort = box(30, desktop);
  check(
    "a mouse still gets grips on a 30-minute block",
    geometry.gripHeightFor(deskShort, false) === 8 && body(deskShort, false) === 12,
    `${geometry.gripHeightFor(deskShort, false)} / ${body(deskShort, false)}`,
  );
  check(
    "and a 15-minute block gets none at any size",
    geometry.gripHeightFor(box(15, desktop), false) === 0 && geometry.gripHeightFor(box(15, phone), true) === 0,
  );

  // The law, over every height rather than the interesting ones.
  let worst = Number.POSITIVE_INFINITY;
  let thin = Number.POSITIVE_INFINITY;
  let monotone = true;
  for (const coarse of [true, false]) {
    const floor = coarse ? geometry.GRIP_BODY_COARSE : geometry.GRIP_BODY_FINE;
    const cap = coarse ? geometry.GRIP_MAX_COARSE : geometry.GRIP_MAX_FINE;
    let previous = 0;
    for (let height = 1; height <= 240; height++) {
      const grip = geometry.gripHeightFor(height, coarse);
      if (grip < previous) monotone = false;
      previous = grip;
      if (grip === 0) continue;
      if (grip < geometry.GRIP_MIN || grip > cap) thin = Math.min(thin, grip);
      worst = Math.min(worst, height - 2 * grip - floor);
    }
  }
  check("a grip is never thinner than the floor or thicker than the cap", thin === Number.POSITIVE_INFINITY, String(thin));
  check("taller blocks never get thinner grips", monotone);
  check(
    "and no block anywhere in the range is left with less than its body",
    worst >= 0,
    `worst margin ${worst}`,
  );
});

group("The calendar's shared module stays client safe", () => {
  const source = readFileSync("src/lib/calendar/geometry.ts", "utf8");
  const specifiers = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((match) => match[1] ?? "");
  check("it imports no node builtin", !specifiers.some((specifier) => specifier.startsWith("node:")), specifiers.join(","));
  check(
    "and nothing that reaches the store",
    !specifiers.some((specifier) => /store|cave\/(types|ops)/.test(specifier)),
    specifiers.join(","),
  );
  check("it does reach the zone helpers", specifiers.some((specifier) => specifier.endsWith("core/zone")));

  const room = readFileSync("src/components/xana/cave/ScheduleRoom.tsx", "utf8");
  check("the room does not format a date on its own", !/toLocale(Time|Date)String/.test(room));
  const month = readFileSync("src/components/xana/cave/calendar/MonthGrid.tsx", "utf8");
  const time = readFileSync("src/components/xana/cave/calendar/TimeGrid.tsx", "utf8");
  check("nor the month grid", !/toLocale(Time|Date)String/.test(month));
  check("nor the time grid", !/toLocale(Time|Date)String/.test(time));
  check("the month grid reaches the zone helpers", /core\/zone/.test(month));
  check("and so does the time grid", /core\/zone/.test(time));
});

/* ------------------------------------------------------------------ */
/* What a phrase says the entry's length is                            */
/* ------------------------------------------------------------------ */

/**
 * A stated range is the length, and it used to be thrown away.
 *
 * The calendar stores a start and an end, and the only thing a person says
 * about the end is a range: "10:00 to 10:30". The parser read the first time
 * and discarded the second, so every entry took the caller's default hour —
 * "breakfast 10:00 to 10:30" was stored as 10:00 to 11:00, and a half-hour
 * breakfast quietly became an hour on the grid. Nothing looks broken about
 * that, which is why it needs an assertion rather than an eye.
 */
await groupAsync("A range states the length", async () => {
  const nlp = await import("../src/lib/core/nlp");
  const at = (date: Date | undefined) =>
    date ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : "—";

  const cases: [string, string, string, string][] = [
    // phrase, start, end, title
    ["breakfast tomorrow 10:00 to 10:30", "10:00", "10:30", "breakfast"],
    ["gym tomorrow from 10:30 to 11:30 am", "10:30", "11:30", "gym"],
    ["shower tomorrow 11:30 to 12:30", "11:30", "12:30", "shower"],
    ["lunch tomorrow 12:00-13:00", "12:00", "13:00", "lunch"],
    ["meeting friday 9am to 10am", "09:00", "10:00", "meeting"],
    ["brunch sunday 11 to 12:30", "11:00", "12:30", "brunch"],
    // The reported sentence's own shape: a bare hour on the left of a dash.
    ["add tomorrow breakfast to my calendar from 10-10:30", "10:00", "10:30", "add breakfast to my calendar"],
  ];

  for (const [phrase, wantStart, wantEnd, wantTitle] of cases) {
    const when = nlp.parseWhen(phrase);
    check(`"${phrase}" has a start`, at(when?.date) === wantStart, `${at(when?.date)} wanted ${wantStart}`);
    check(`"${phrase}" has an end`, at(when?.end) === wantEnd, `${at(when?.end)} wanted ${wantEnd}`);
    const title = when ? nlp.stripWhen(phrase, when.matched) : "";
    check(`"${phrase}" leaves the title`, title === wantTitle, `"${title}" wanted "${wantTitle}"`);
  }

  // A range that reads backwards is refused rather than wrapped through
  // midnight: "10 to 9" is a parse failure, not an eleven-hour booking.
  const backwards = nlp.parseWhen("review tomorrow 10 to 9");
  check("a backwards range is not treated as overnight", backwards?.end === undefined, at(backwards?.end));

  // A single time still has no end, so a duration or the default can apply.
  const single = nlp.parseWhen("standup tomorrow at 9:15");
  check("a single time states no end", single?.end === undefined, at(single?.end));
  check("and it is still a clock time", single?.hasTime === true);

  // A bare numeral is not a time, and must not become one by accident.
  const notATime = nlp.parseWhen("review 5 PRs tomorrow");
  check("a bare numeral in a title is not a clock time", notATime?.hasTime === false, String(notATime?.hasTime));
});

/*
 * Turning the page with a finger.
 *
 * The decision function is pure and exported for exactly this reason: the
 * thresholds *are* the behaviour, and a gesture recogniser whose edges are only
 * ever found by a person using it is one whose edges are wrong for a year
 * before anyone says so. Everything below is a fixed dx/dy/time, so these
 * assertions are the same numbers on every machine.
 *
 * A note on the signs, because they are the easiest thing here to get backwards:
 * `dx` is the finger's travel and the returned step is the *content's*, so a
 * finger moving right (positive dx) returns `-1` — the previous period arrives
 * from the left. A test written the other way round passes while the calendar
 * pages backwards, which is why the direction is asserted both ways below.
 */
group("A swipe decides which way the page turns", () => {
  const WIDE = 390;
  const DESKTOP = 1440;

  // 22% of 390 is 85.8, and the floor is 48.
  const phone = swipe.thresholdFor(WIDE);
  check("a phone asks for a fifth of its width", Math.round(phone) === 86, String(phone));
  check("a swipe is never a hair-trigger", swipe.thresholdFor(120) === 48, String(swipe.thresholdFor(120)));

  /*
   * The cap, which a probe of the real function found rather than a reading of
   * it: the share alone asks for 316px at 1440px, so a touchscreen laptop would
   * have had to drag a third of the window to change week. A hand does not get
   * longer because the screen did.
   */
  check("and a wide window does not ask for a longer arm", swipe.thresholdFor(DESKTOP) === 160, String(swipe.thresholdFor(DESKTOP)));

  // A deliberate drag, past the distance.
  check("a finger dragged right turns back a period", swipe.pageStep(120, 0, 600, WIDE) === -1);
  check("a finger dragged left turns forward one", swipe.pageStep(-120, 0, 600, WIDE) === 1);

  // A flick, which is short but fast — the case the distance test alone misses.
  check("a quick short flick still turns the page", swipe.pageStep(-30, 0, 40, WIDE) === 1, String(swipe.pageStep(-30, 0, 40, WIDE)));
  check("and a quick flick the other way turns it back", swipe.pageStep(30, 0, 40, WIDE) === -1);

  // Scrolling wins the vertical axis outright: a day is 24 hours tall.
  check("a mostly vertical move is a scroll, not a page turn", swipe.pageStep(20, 90, 200, WIDE) === null);
  check("and a diagonal drag that is mostly down is still a scroll", swipe.pageStep(40, 120, 300, WIDE) === null);

  // A tap is a tap: the grid's own "put something here" must survive.
  check("a tap turns nothing", swipe.pageStep(2, 0, 100, WIDE) === null);
  check("and neither does a press that never moved", swipe.pageStep(0, 0, 400, WIDE) === null);

  /*
   * The time limit, which is the difference between a swipe and a drag that
   * happens to be sideways. Somebody slowly repositioning something across a
   * week is not asking for next week, and at 120px it would otherwise pass the
   * distance test.
   */
  check("a slow crawl across the grid is not a page turn", swipe.pageStep(120, 0, 900, WIDE) === null);
  check("but the same distance quickly is", swipe.pageStep(120, 0, 400, WIDE) === -1);

  // Below the distance floor and too slow to flick: nothing.
  check("a short slow nudge turns nothing", swipe.pageStep(40, 0, 500, WIDE) === null);

  // An explicit distance wins, which is what the option is for.
  check("an explicit distance overrides the share", swipe.thresholdFor(WIDE, 200) === 200);
  check("and it is honoured by the decision", swipe.pageStep(120, 0, 600, WIDE, 200) === null);

  // A nonsense width must not become a nonsense threshold.
  check("a zero width falls back rather than dividing by nothing", swipe.thresholdFor(0) === 120, String(swipe.thresholdFor(0)));
  check("and so does a NaN", swipe.thresholdFor(Number.NaN) === 120, String(swipe.thresholdFor(Number.NaN)));
});

/*
 * The page turn must survive a finger that lifted without asking for one, and
 * must never leave the grid nudged sideways.
 *
 * This is the contract `pointerDrag` spells out and this hook had to be written
 * to as well: any preview drawn during a gesture is taken down on *every* path
 * out of it. Asserted here as the totality of the ending rather than by driving
 * the DOM, because what can go wrong is a path that reaches neither branch.
 */
group("A swipe ends exactly once, on every path", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/components/xana/cave/calendar/useSwipePage.ts"),
    "utf8",
  );

  check(
    "the gesture is marked finished before anything else can run",
    /if \(finished\) return;\s*\n\s*finished = true;/.test(source),
  );
  check(
    "every ending funnels through one release",
    (source.match(/release\(/g) ?? []).length >= 4,
    String((source.match(/release\(/g) ?? []).length),
  );
  check("a cancelled pointer is an ending, not silence", /pointercancel/.test(source));
  check("a lost window focus is an ending too", /addEventListener\("blur"/.test(source));

  /*
   * The interrupt that matters most: a block drag arms on a hold and captures the
   * pointer, so this listener stops hearing `pointermove` while the `pointerup`
   * still arrives. Without the capture test, dragging a block sideways would also
   * turn the page underneath it — the block moved *and* the grid changed, from
   * one gesture.
   */
  check("a block that captured the pointer silences the swipe", /capturedByABlock/.test(source));
  check("and the test asks about capture, not about what is under the finger", /hasPointerCapture/.test(source));

  // Reduced motion is honoured in the path that does the work, not only in CSS,
  // because the page-turn delay is a timer and no media query can reach a timer.
  check("the OS's reduced-motion setting is read for the turn", /prefers-reduced-motion/.test(source));
  check("and with it the page turns without travel", /duration > 0/.test(source));
});

/*
 * A failed cleanup must not be reported as a failed suite.
 *
 * On Windows the store still holds the SQLite file's handle for a moment after
 * `closeStore()`, and a sandbox can refuse the delete outright, so this threw
 * EPERM *after* every assertion had run and exited 1 on a green suite. The temp
 * directory is disposable; the verdict is not its business.
 */
try {
  rmSync(DATA_DIR, { recursive: true, force: true });
} catch {
  /* the OS will collect it */
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
