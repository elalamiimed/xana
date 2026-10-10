/**
 * Planning: decomposition, the verifier that guards it, and when to speak up.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-planning.ts
 *
 * OFFLINE. `decomposeGoal` never reaches for a model, and the only function
 * here that can is asserted to fall back to the deterministic skeleton when one
 * is not configured - which is also the state this suite runs in.
 *
 * The utility numbers are printed rather than only asserted, because the point
 * of the Horvitz rule is that the *shape* of the curve is inspectable: a reader
 * should be able to see that a 0.9-relevant item clears the bar at 8am and the
 * same item does not at 3am.
 */

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

const { decomposeGoal, decomposeGoalWithModel, validateMilestones, MAX_MILESTONES } = await import(
  "../src/lib/mind/plan"
);
const { parseIntention, intentionSentence } = await import("../src/lib/derived/intentions");
const { decideProactive, selectDeliveries, timeRelevance, interruptionCost, DEFAULT_THRESHOLD } =
  await import("../src/lib/derived/proactive");

/* ------------------------------------------------------------------ */
console.log("\nA goal becomes milestones with no model at all\n");

const future = new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10);
const skeleton = decomposeGoal({ title: "Run a half marathon", horizon: "mid", targetDate: future });

console.log(`    ${skeleton.length} milestones for a six-month goal, ending ${skeleton.at(-1)?.due}`);
for (const m of skeleton) console.log(`      ${m.due}  ${m.title}`);

check("it produces something", skeleton.length > 0);
check("the count is a plan, not a spreadsheet", skeleton.length <= MAX_MILESTONES);
check("every milestone has a title", skeleton.every((m) => m.title.length > 3));
check("every milestone has a date", skeleton.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.due ?? "")));
check("orders are dense and ascending", skeleton.every((m, i) => m.order === i));
check(
  "dates are strictly increasing",
  skeleton.every((m, i) => i === 0 || (m.due ?? "") > (skeleton[i - 1].due ?? "")),
  skeleton.map((m) => m.due).join(","),
);
check(
  "the last one lands on the date the user named",
  skeleton.at(-1)?.due === future,
  `${skeleton.at(-1)?.due} vs ${future}`,
);

const noDate = decomposeGoal({ title: "Learn to sail", horizon: "short" });
check("a goal with no target date still decomposes", noDate.length > 0);
check("and its dates are in the future", noDate.every((m) => (m.due ?? "") > new Date().toISOString().slice(0, 10)));
check("a longer horizon gets more checkpoints", decomposeGoal({ title: "x", horizon: "long" }).length >= skeleton.length);

/* ------------------------------------------------------------------ */
console.log("\nThe verifier is what lets a model near a plan\n");

const good = [
  { title: "Run 5km without stopping", due: future, order: 0 },
  { title: "Run 10km", due: future, order: 1 },
];
check("a sound proposal survives", validateMilestones(good, future).length === 2);

const cases: Array<[string, unknown]> = [
  ["not an array", { milestones: [] }],
  ["a string", "Run more"],
  ["null", null],
  ["empty titles", [{ title: "   ", order: 0 }]],
  ["titles too short", [{ title: "ab", order: 0 }]],
  ["a date past the goal's deadline", [{ title: "Run 5km", due: "2099-01-01", order: 0 }]],
  ["an unparseable date", [{ title: "Run 5km", due: "next thursday-ish", order: 0 }]],
  ["a non-string date", [{ title: "Run 5km", due: 12345, order: 0 }]],
  ["entries that are not objects", [null, 42, "run"]],
];
for (const [label, input] of cases) {
  const survivors = validateMilestones(input, future);
  check(`refused: ${label}`, survivors.length === 0, JSON.stringify(survivors));
}

const dupes = validateMilestones([{ title: "Run 5km", order: 0 }, { title: "run 5KM", order: 1 }], future);
check(
  "duplicate titles differing only in case are collapsed",
  dupes.length === 1,
  JSON.stringify(dupes),
);
check("and the first of them is the survivor", dupes[0]?.title === "Run 5km", dupes[0]?.title);

const spaced = validateMilestones([{ title: "Run 5km", order: 0 }, { title: "  run   5KM  ", order: 1 }], future);
check("whitespace alone does not make two steps", spaced.length === 1, JSON.stringify(spaced));

const many = Array.from({ length: 20 }, (_, i) => ({ title: `Step number ${i}`, order: i }));
check(`capped at ${MAX_MILESTONES}`, validateMilestones(many, undefined).length === MAX_MILESTONES);

const gapped = [
  { title: "First thing", order: 7 },
  { title: "Second thing", order: 2 },
  { title: "Third thing", order: 40 },
];
const renumbered = validateMilestones(gapped, undefined);
check("out-of-order proposals are sorted", renumbered.map((m) => m.title).join(",") === "Second thing,First thing,Third thing");
check("and renumbered densely", renumbered.every((m, i) => m.order === i), renumbered.map((m) => m.order).join(","));

const fractional = [{ title: "A real step", order: 1.5 }];
check("a non-integer order does not disqualify the step", validateMilestones(fractional, undefined).length === 1);
check("an absent order is allowed", validateMilestones([{ title: "A real step" }], undefined).length === 1);

/* An empty array is a valid answer meaning "nothing survived" - the caller
 * falls back to the skeleton. It must not throw. */
check("an empty list is a valid answer", validateMilestones([], future).length === 0);

/* ------------------------------------------------------------------ */
console.log("\nWith no model configured, the skeleton is what is used\n");

const { proposals, by } = await decomposeGoalWithModel({ title: "Write a book", horizon: "long" });
check("the offline path is taken", by === "skeleton", by);
check("and it returns a usable plan", proposals.length > 0);

/* ------------------------------------------------------------------ */
console.log("\nIf/then intentions are parsed, not invented\n");

const parsed = parseIntention("When I get in on Tuesdays I'll run with the group");
check("both halves are found", parsed !== undefined);
check("the trigger is the cue", parsed?.trigger === "I get in on Tuesdays", parsed?.trigger);
check("the action is the act", parsed?.action === "run with the group", parsed?.action);

const whenForm = parseIntention("when it is 7am, then I will do the physio exercises");
check("the 'then I will' form works", whenForm?.action === "do the physio exercises", whenForm?.action);

check("an action with no cue is refused", parseIntention("I will run more") === undefined);
check("a cue with no action is refused", parseIntention("when I get home") === undefined);
check("an empty string is refused", parseIntention("") === undefined);

const sentence = intentionSentence(
  { id: "i1", goalId: "g1", trigger: "It is Tuesday morning", action: "Run with the group", createdAt: "" },
  "half marathon",
);
console.log(`    "${sentence}"`);
check("the sentence reads as an if/then", /^If .+, then .+/.test(sentence));
check("it names the goal", sentence.includes("half marathon"));
check("it does not scold or reopen the decision", !/should|must|need to/i.test(sentence));

/* ------------------------------------------------------------------ */
console.log("\nWhen to speak, and when to stay quiet\n");

const morning = new Date(2026, 9, 9, 8, 0, 0);
const afternoon = new Date(2026, 9, 9, 15, 0, 0);
const night = new Date(2026, 9, 9, 2, 0, 0);

console.log(`    relevance by hour: 8am=${timeRelevance(morning)} 3pm=${timeRelevance(afternoon)} 2am=${timeRelevance(night)}`);
check("morning is the most relevant hour", timeRelevance(morning) > timeRelevance(afternoon));
check("the small hours are the least", timeRelevance(night) < timeRelevance(afternoon));

const candidate = { kind: "nudge" as const, text: "The deck review is two days overdue.", relevance: 0.8, interruptionCost: 0.4 };

const atMorning = decideProactive([candidate], morning);
console.log(`    8am  -> utility ${atMorning[0].utility.toFixed(3)}  deliver=${atMorning[0].deliver}  (${atMorning[0].reason})`);
check("a relevant nudge at 8am is delivered", atMorning[0].deliver === true);

const atNight = decideProactive([candidate], night);
console.log(`    2am  -> utility ${atNight[0].utility.toFixed(3)}  deliver=${atNight[0].deliver}  (${atNight[0].reason})`);
check("the same nudge at 2am is suppressed", atNight[0].deliver === false);
check("and it says why", /quiet hours/.test(atNight[0].reason), atNight[0].reason);

/* Quiet hours wrap midnight. A naive range check silently never fires, which
 * means the first anyone knows is being woken at 2am. */
for (const hour of [22, 23, 0, 3, 6]) {
  const at = new Date(2026, 9, 9, hour, 0, 0);
  check(`quiet at ${hour}:00`, decideProactive([candidate], at)[0].deliver === false);
}
for (const hour of [7, 12, 18]) {
  const at = new Date(2026, 9, 9, hour, 0, 0);
  check(`not quiet at ${hour}:00`, decideProactive([candidate], at)[0].deliver === true);
}

/**
 * A life state carrying one event that is happening right now.
 *
 * Cast rather than built in full: this suite cares about two fields, and
 * constructing all sixteen would be noise that drifts out of date every time the
 * state grows - which is the same reason `check-mind-loop.ts` builds its state
 * the same way.
 */
const inMeeting = decideProactive([candidate], morning, {
  calendar: {
    today: [
      {
        id: "e1",
        title: "Standup",
        start: new Date(2026, 9, 9, 7, 45).toISOString(),
        end: new Date(2026, 9, 9, 8, 30).toISOString(),
      },
    ],
    next: undefined,
    freeMinutes: 0,
  },
} as unknown as Parameters<typeof decideProactive>[2]);
check("a nudge during a meeting is suppressed", inMeeting[0].deliver === false);
check("and it says so", /meeting/.test(inMeeting[0].reason), inMeeting[0].reason);

const focussing = decideProactive([candidate], morning, undefined, { inFocusSession: true });
check("a nudge during a focus session is suppressed", focussing[0].deliver === false);
const intentionDuringFocus = decideProactive([{ ...candidate, kind: "intention" }], morning, undefined, {
  inFocusSession: true,
});
check(
  "but an intention may still fire, because the session may be its cue",
  intentionDuringFocus[0].deliver === true,
);

const spent = decideProactive([candidate], morning, undefined, { deliveredToday: 3, budgetPerDay: 3 });
check("the daily budget stops her", spent[0].deliver === false);
check("and the reason counts it", /budget/.test(spent[0].reason), spent[0].reason);

const weak = decideProactive([{ ...candidate, relevance: 0.1 }], morning);
console.log(`    weak  -> utility ${weak[0].utility.toFixed(3)}  deliver=${weak[0].deliver}  (${weak[0].reason})`);
check("something barely relevant is not worth saying", weak[0].deliver === false);
check("the threshold is the documented one", weak[0].reason.includes(String(DEFAULT_THRESHOLD)), weak[0].reason);

/* Horvitz is a difference, not a score: a highly relevant item survives a high
 * cost, and a marginally relevant one does not survive the same cost. */
const urgent = decideProactive([{ ...candidate, relevance: 0.95, interruptionCost: 0.9 }], afternoon);
const marginal = decideProactive([{ ...candidate, relevance: 0.3, interruptionCost: 0.9 }], afternoon);
console.log(`    cost 0.9: relevance 0.95 -> ${urgent[0].utility.toFixed(3)} (deliver=${urgent[0].deliver}); relevance 0.30 -> ${marginal[0].utility.toFixed(3)} (deliver=${marginal[0].deliver})`);
check("relevance beats cost when it is high", urgent[0].deliver === true);
check("and does not when it is low", marginal[0].deliver === false);

const many2 = [
  { kind: "nudge" as const, text: "c", relevance: 0.5, interruptionCost: 0.3 },
  { kind: "nudge" as const, text: "a", relevance: 0.95, interruptionCost: 0.3 },
  { kind: "nudge" as const, text: "b", relevance: 0.8, interruptionCost: 0.3 },
];
const picked = selectDeliveries(decideProactive(many2, morning), 2);
check("only the budget is delivered", picked.length === 2, String(picked.length));
check("best first", picked[0].candidate.text === "a" && picked[1].candidate.text === "b", picked.map((p) => p.candidate.text).join(","));

check("a calendar at 3pm costs more than an empty evening", interruptionCost(afternoon, undefined) > interruptionCost(new Date(2026, 9, 9, 18, 0), undefined));

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;

export {};
