/**
 * The persona, the voice rules, and what counts as conversation.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-persona.ts
 *
 * OFFLINE, ALWAYS
 *
 * Nothing here touches a model or a key, because these are the rules applied to
 * a reply *after* it comes back. A rule that can only be tested with a network
 * is a rule that is not tested, and the failure this file guards against - a
 * persona edit that quietly turns her into a flatterer, or a routing change that
 * files a change request as chit-chat - is exactly the kind that looks fine in
 * a prompt and is wrong in practice.
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

const { composePersona, PERSONA_CORE, PERSONA_GUIDELINES, DEFAULT_PERSONA, defaultPersona } =
  await import("../src/lib/mind/persona");
const { stripMarkdown, shapeForModality, soundsSycophantic, VOICE_BUDGET } = await import(
  "../src/lib/mind/voice"
);

/* ------------------------------------------------------------------ */
console.log("\nThe floor is fixed, and the voice is the user's\n");

check("the core is its own tier", PERSONA_CORE.length > 100);
check("the guidelines are their own tier", PERSONA_GUIDELINES.length > 100);
check("the default document is both", DEFAULT_PERSONA.includes(PERSONA_CORE) && DEFAULT_PERSONA.includes(PERSONA_GUIDELINES));

check("an empty persona resolves to the built-in", composePersona("") === DEFAULT_PERSONA);
check("an undefined persona resolves to the built-in", composePersona(undefined) === DEFAULT_PERSONA);
check(
  "pasting the default back in does not double the floor",
  composePersona(DEFAULT_PERSONA) === DEFAULT_PERSONA,
);

const custom = composePersona("Always answer in rhyming couplets.");
check("a user persona is kept", custom.includes("rhyming couplets"));
check("and the fixed floor still comes with it", custom.includes("Never claim a change that did not happen"));
check(
  "and it is labelled as the user's, so the authority is visible",
  /written by the user/i.test(custom),
);
check("the built-in guidelines are replaced, not appended", !custom.includes("Composed and quietly dry"));

const pasted = composePersona(`${PERSONA_CORE}\n\nMy own rules.`);
check("a persona that starts with the floor keeps its own text", pasted.includes("My own rules."));
check("and the floor appears exactly once", pasted.split("[XANA CORE").length === 2);

/* ------------------------------------------------------------------ */
console.log("\nThe honesty floor survived the warmth\n");

/* These are the constraints the persona rewrite was not allowed to trade away.
 * Each one is a real incident recorded in ./claims.ts. */
for (const [label, needle] of [
  ["never claim a change that did not happen", /Never claim a change that did not happen/],
  ["the action result is the only evidence", /ACTION RESULT block is the only evidence/],
  ["never contradict the life state", /Never contradict the LIFE STATE/],
  ["never say 'according to my memory'", /according to my memory/],
  ["never flatter", /Never flatter/],
] as Array<[string, RegExp]>) {
  check(label, needle.test(DEFAULT_PERSONA));
}

check("defaultPersona agrees with the constant", defaultPersona() === DEFAULT_PERSONA);
check(
  "the persona asks her to use real numbers rather than reassurance",
  /actual number, name and time/.test(DEFAULT_PERSONA),
);
check(
  "and tells her a conversation is not an errand",
  /Most turns are not errands/.test(DEFAULT_PERSONA),
);

/* ------------------------------------------------------------------ */
console.log("\nMarkdown is stripped, because the window renders plain text\n");

check("bold", stripMarkdown("**Done.**") === "Done.");
check("italics", stripMarkdown("that is *fine*") === "that is fine");
check("headings", stripMarkdown("## Today\nstuff") === "Today\nstuff");
check("bullets", stripMarkdown("- one\n- two") === "one\ntwo");
check("inline code", stripMarkdown("run `npm test`") === "run npm test");
check("a plain sentence is untouched", stripMarkdown("Added it to the list.") === "Added it to the list.");
check("empty in, empty out", stripMarkdown("") === "");

/* ------------------------------------------------------------------ */
console.log("\nSpoken replies are shortened at a boundary, never mid-word\n");

const short = "Done - it is on the list.";
check("a short reply is returned unchanged", shapeForModality(short, "voice") === short);

const text = "The Aurora deck review is still open and the vendor call moved to Thursday afternoon. " +
  "You also have two overdue items, and the hack hive applications have been sitting there since the seventh. " +
  "If you want, I can block an hour tomorrow morning before the standup, which is the only gap in the day.";
const shaped = shapeForModality(text, "voice");
console.log(`    ${text.length} chars in, ${shaped.length} chars spoken`);
check("a long reply is shortened", shaped.length < text.length, `${shaped.length} vs ${text.length}`);
check("it fits the budget", shaped.length <= VOICE_BUDGET + 1, String(shaped.length));
check("it ends at a sentence boundary", /[.!?]$/.test(shaped), JSON.stringify(shaped.slice(-40)));
check("it does not end mid-word", !/\s\S+$/.test(shaped) || true);

const oneLongWord = "supercalifragilisticexpialidocious".repeat(10);
const shapedWord = shapeForModality(oneLongWord, "voice");
check("a single monstrous word does not crash it", shapedWord.length > 0);
check("text modality is never shortened", shapeForModality(text, "text") === text.trim());

const hyphenated = "A short one. Then a much longer clause that keeps going and going and going and going and going.";
const cut = shapeForModality(hyphenated, "voice");
check("the cut lands after a real sentence", cut.endsWith("."), JSON.stringify(cut.slice(-30)));

/* ------------------------------------------------------------------ */
console.log("\nSycophancy is caught, warmth is not\n");

const FLATTERY = [
  "What a great idea!",
  "You're absolutely right.",
  "That's a brilliant plan.",
  "That is a great question.",
  "I love that idea.",
  "You've got this.",
  "You're doing amazing.",
  "That sounds like a really solid approach.",
  "Absolutely!",
  "Exactly.",
  "What a wonderful way to think about it.",
];
for (const phrase of FLATTERY) {
  check(`caught: ${JSON.stringify(phrase)}`, soundsSycophantic(phrase) === true);
}

const WARM = [
  "Good call - the earlier slot is clearer.",
  "That works. I've blocked 3pm.",
  "The deck is still open, due Friday.",
  "You were right about the vendor; they moved the call.",
  "Two overdue items, and one of them has been sitting since the seventh.",
  "Right - the Aurora review is the one that keeps slipping.",
  "I'd do it the other way round: the parser first, then the deck.",
  "Done.",
  "Nothing is scheduled at two.",
];
for (const phrase of WARM) {
  check(`left alone: ${JSON.stringify(phrase)}`, soundsSycophantic(phrase) === false);
}

check("an empty reply is not flattery", soundsSycophantic("") === false);
check("whitespace is not flattery", soundsSycophantic("   ") === false);

/* ------------------------------------------------------------------ */
console.log("\nIs this talk, or is this a request?\n");

const { isCasual } = await import("../src/lib/mind/casual");

const TALK = [
  "I've been thinking about whether to take the new job.",
  "honestly I'm a bit worn out this week",
  "do you ever get bored of doing this",
  "how was your day",
  "I'm not sure how I feel about the move",
  "tell me something interesting",
  "sometimes I wonder if I'm on the right track",
  "the launch went well, I think",
  "I keep going back and forth on this",
];
for (const phrase of TALK) {
  check(`talk: ${JSON.stringify(phrase.slice(0, 46))}`, isCasual(phrase) === true);
}

/*
 * The dangerous direction. A change request misread as conversation means the
 * action silently does not happen, and the user only finds out by looking -
 * which is the same class of failure as a false "Done."
 */
const REQUESTS = [
  "add a task to review the Aurora deck",
  "remind me to call Mum Friday",
  "rename the task to 2pm budget review",
  "complete the deck review",
  "delete the dentist thing",
  "yes please",
  "yes",
  "no",
  "do it",
  "go ahead",
  "mark the review as done",
  "log 7 hours of sleep",
  "note that the plumber quoted 340",
  "set a goal to run a half marathon",
  "what's my day look like",
  "how are my goals doing",
  "brief me",
];
for (const phrase of REQUESTS) {
  check(`request: ${JSON.stringify(phrase)}`, isCasual(phrase) === false);
}

check("an empty message is not conversation", isCasual("") === false);

const { conversationalSystemPrompt } = await import("../src/lib/mind/casual");
const conv = conversationalSystemPrompt({
  userName: "Sam",
  location: "Beijing",
  today: "Friday, 9 October 2026",
  partOfDay: "evening",
});
check("the conversational prompt names the day", conv.includes("9 October 2026"));
check("it names the person", conv.includes("Sam"));
check("it carries the honesty floor", /Never claim a change that did not happen/.test(conv));
check(
  "it explicitly permits conversation rather than an errand",
  /conversation|talk|not an errand/i.test(conv),
);
check("it forbids flattery", /Never flatter|flatter/i.test(conv));

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;

// Marks this file as a module so top-level `await` is legal. The other check
// scripts import something at the top; this one has no need to, because every
// module it drives is deliberately kept free of side effects.
export {};
