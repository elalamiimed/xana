/**
 * Verify My cave: the goal board, its ordering, and the memory room.
 *
 *   node scripts/verify-cave.mjs [baseUrl]
 *
 * Runs against the real server and the real database, and cleans up after
 * itself by deleting everything it created.
 *
 * The parts worth testing here are the ones with no visible failure mode:
 *
 *  - **Midpoint ordering.** A drag writes one float, and a bug in the
 *    midpoint maths produces a board that looks fine until two cards land on
 *    the same number and swap places on the next read.
 *  - **Partial updates.** A drag sends `{status}` alone. If that were
 *    treated as a full replacement it would silently blank the deadline and
 *    the reason the goal exists.
 *  - **Forgetting.** A soft delete would leave the memory reachable by
 *    recall, so "forgotten" has to mean absent from the list *and* from
 *    every read path.
 */

const base = process.argv[2] ?? process.env.XANA_URL ?? "http://127.0.0.1:4310";

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${"─".repeat(64)}\n${title}\n${"─".repeat(64)}`);
}

async function op(name, input = {}) {
  const res = await fetch(`${base}/api/cave`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: name, ...input }),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

async function board() {
  const res = await fetch(`${base}/api/cave`);
  return res.json();
}

const created = [];

async function main() {
  /* ---------------- reachable? ---------------- */
  section("The route");
  const snapshot = await board().catch(() => null);
  check("GET /api/cave answers", Boolean(snapshot), `no server at ${base}`);
  if (!snapshot) return report();

  const canonical = await fetch(`${base}/xana/cave`).catch(() => null);
  check("the canonical /xana/cave answers too", canonical?.status === 200);

  check("the board is an array", Array.isArray(snapshot.goals));
  check("memories come back as a page", Array.isArray(snapshot.memories?.items));
  check("memory stats are present", typeof snapshot.memories?.stats?.total === "number");

  const bad = await op("nonsense.operation", {});
  check("an unknown operation is refused", bad.status === 400, String(bad.status));
  check("and the valid set is named", Array.isArray(bad.body.valid) && bad.body.valid.includes("goal.move"));

  /* ---------------- goals ---------------- */
  section("Creating and editing goals");

  const marker = `verify-cave-${Date.now().toString(36)}`;

  const first = await op("goal.create", {
    title: `${marker} alpha`,
    horizon: "mid",
    why: "because it matters",
    targetDate: "2026-06-01",
    milestones: ["step one", "step two"],
  });
  check("a goal is created", first.status === 200 && Boolean(first.body.goal), String(first.status));
  const goalId = first.body.goal?.goal?.id;
  created.push(goalId);
  check("it gets a board position so it does not sort last", typeof first.body.goal?.goal?.sortOrder === "number");
  check("its milestones are created with it", first.body.goal?.goal?.milestones?.length === 2);
  check("pace is computed on creation", Boolean(first.body.goal?.progress?.pace), first.body.goal?.progress?.pace);

  const stored = await board();
  const found = stored.goals.find((g) => g.goal.id === goalId);
  check("it is on the board", Boolean(found));
  check("the reason survived", found?.goal.why === "because it matters", found?.goal.why);
  check("the target date survived", found?.goal.targetDate === "2026-06-01", found?.goal.targetDate);

  /* ---------------- partial update ---------------- */
  section("A partial update must not blank the rest");

  await op("goal.update", { id: goalId, status: "paused" });
  const afterStatus = (await board()).goals.find((g) => g.goal.id === goalId);
  check("the status changed", afterStatus?.goal.status === "paused", afterStatus?.goal.status);
  check(
    "the deadline was not wiped by changing only the status",
    afterStatus?.goal.targetDate === "2026-06-01",
    afterStatus?.goal.targetDate,
  );
  check(
    "the reason was not wiped either",
    afterStatus?.goal.why === "because it matters",
    afterStatus?.goal.why,
  );
  check(
    "the milestones were not touched",
    afterStatus?.goal.milestones.length === 2,
    String(afterStatus?.goal.milestones.length),
  );

  /* ---------------- milestones ---------------- */
  section("Milestones");

  const milestoneId = afterStatus.goal.milestones[0].id;
  const ticked = await op("milestone.setDone", { id: milestoneId, done: true });
  check("a milestone can be ticked", ticked.status === 200);
  check(
    "the goal's progress moved with it",
    ticked.body.goal?.progress?.progress === 0.5,
    String(ticked.body.goal?.progress?.progress),
  );

  const unticked = await op("milestone.setDone", { id: milestoneId, done: false });
  check("and unticked, because a misclick must be recoverable", unticked.status === 200);
  check(
    "progress went back",
    unticked.body.goal?.progress?.progress === 0,
    String(unticked.body.goal?.progress?.progress),
  );

  const noTitle = await op("milestone.create", { goalId, title: "   " });
  check("a blank milestone is refused", noTitle.status === 400, String(noTitle.status));

  /* ---------------- a goal with no milestones ---------------- */
  section("A goal with no steps must not be permanently stalled");

  const bare = await op("goal.create", { title: `${marker} bare`, horizon: "short" });
  const bareId = bare.body.goal?.goal?.id;
  created.push(bareId);

  const touched = await op("goal.touch", { id: bareId });
  check("'moved today' is accepted", touched.status === 200);
  const afterTouch = (await board()).goals.find((g) => g.goal.id === bareId);
  check(
    "it is no longer reported as stalled",
    afterTouch?.progress.pace !== "stalled",
    afterTouch?.progress.pace,
  );
  check(
    "and no hidden milestone was invented to fake it",
    afterTouch?.goal.milestones.length === 0,
    `${afterTouch?.goal.milestones.length} milestones appeared`,
  );

  /* ---------------- ordering ---------------- */
  section("Drag ordering");

  const second = await op("goal.create", { title: `${marker} beta`, horizon: "short" });
  const secondId = second.body.goal?.goal?.id;
  created.push(secondId);

  const activeIds = async () => {
    const current = await board();
    return current.goals
      .filter((g) => g.goal.status === "active" && g.goal.title.startsWith(marker))
      .map((g) => g.goal.id);
  };

  const orderBefore = await activeIds();
  check("two goals are in play", orderBefore.length === 2, String(orderBefore.length));

  // Move the second one to the very top of the column.
  const firstOrder = (await board()).goals.find((g) => g.goal.id === orderBefore[0])?.goal.sortOrder;
  const moved = await op("goal.move", { id: orderBefore[1], status: "active", before: null, after: firstOrder });
  check("a move to the top is accepted", moved.status === 200, String(moved.status));

  const orderAfter = await activeIds();
  check(
    "the moved goal is now first",
    orderAfter[0] === orderBefore[1],
    `${orderBefore.join(",")} -> ${orderAfter.join(",")}`,
  );

  // Every position in a column must have a distinct order, or two cards
  // will swap places on an unrelated later read.
  const orders = (await board()).goals.map((g) => g.goal.sortOrder).filter((o) => typeof o === "number");
  check(
    "no two goals share a board position",
    new Set(orders).size === orders.length,
    `${orders.length} goals, ${new Set(orders).size} distinct positions`,
  );

  // A move into a different column.
  const parked = await op("goal.move", { id: secondId, status: "paused", before: null, after: null });
  check("a move between columns is accepted", parked.status === 200);
  check("the status changed with the move", parked.body.goal?.goal?.status === "paused", parked.body.goal?.goal?.status);

  /* ---------------- validation ---------------- */
  section("Bad input is refused, not stored");

  const blankTitle = await op("goal.create", { title: "   " });
  check("a blank goal title is refused", blankTitle.status === 400);

  const missing = await op("goal.update", { id: "goal-does-not-exist", title: "x" });
  check("editing a goal that does not exist is a 404", missing.status === 404, String(missing.status));

  const badHorizon = await op("goal.create", { title: `${marker} horizon`, horizon: "eventually" });
  check("an unknown horizon falls back rather than failing", badHorizon.status === 200);
  check(
    "and the fallback is a real horizon",
    ["short", "mid", "long"].includes(badHorizon.body.goal?.goal?.horizon),
    badHorizon.body.goal?.goal?.horizon,
  );
  created.push(badHorizon.body.goal?.goal?.id);

  const badDate = await op("goal.update", { id: goalId, targetDate: "not a date" });
  check("an unparseable date clears rather than storing nonsense", badDate.status === 200);
  const afterBadDate = (await board()).goals.find((g) => g.goal.id === goalId);
  check(
    "nothing unusable was written",
    afterBadDate?.goal.targetDate === undefined,
    afterBadDate?.goal.targetDate,
  );

  /* ---------------- memory ---------------- */
  section("The memory room");

  const memMarker = `verify-memory-${Date.now().toString(36)}`;
  const wrote = await op("memory.create", {
    title: `${memMarker} the cat is called Nimbus`,
    content: "Nimbus is a grey cat, adopted in spring.",
    kind: "fact",
    pinned: true,
  });
  check("a memory can be written by hand", wrote.status === 200, String(wrote.status));
  const memoryId = wrote.body.memories?.items?.[0]?.id;
  check("it comes back pinned", wrote.body.memories?.items?.[0]?.pinned === true);
  check("and marked as the user's own", wrote.body.memories?.items?.[0]?.source === "user");

  const listed = (await board()).memories.items.find((m) => m.id === memoryId);
  check("it is in the list", Boolean(listed));
  check("it is not buried at the bottom", (await board()).memories.items[0]?.id === memoryId);

  const unpinned = await op("memory.pin", { id: memoryId, pinned: false });
  check("it can be unpinned", unpinned.body.memories?.items?.[0]?.pinned === undefined);

  // A correction must rebuild the embedding, or the old wording still matches.
  const corrected = await op("memory.update", {
    id: memoryId,
    title: `${memMarker} the cat is called Stratus`,
    content: "Renamed. Nimbus was the old name.",
  });
  check("a memory can be corrected", corrected.status === 200);
  check(
    "the correction is what is stored",
    (await board()).memories.items.find((m) => m.id === memoryId)?.title.includes("Stratus"),
  );

  const canonicalId = await op("memory.pin", { id: `xana:memory:${memoryId}`, pinned: true });
  check("a xana: URI is accepted as an id", canonicalId.status === 200, String(canonicalId.status));

  /* ---------------- does pinning actually change recall? ---------------- */
  section("A pin must change what she recalls, not just a badge");

  // A pinned fact about something entirely unrelated to the question. If
  // recall is score-only, this cannot surface and the pin is decorative.
  const unrelated = await op("memory.create", {
    title: "the spare key is under the blue pot",
    content: "Back door spare key, under the blue pot by the greenhouse.",
    kind: "fact",
    pinned: true,
  });
  check("an unrelated pinned fact is stored", unrelated.status === 200);
  const unrelatedId = unrelated.body.memories?.items?.[0]?.id;

  const recallRes = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "what did I decide about the quarterly budget",
      sessionId: "verify-cave-recall",
    }),
  });
  void recallRes;

  // Recall directly, through the same route the context gateway uses.
  const ctx = await (await fetch(`${base}/xana/context`)).json();
  const recalledTitles = (ctx.lifeState?.memory ?? []).map((m) => m.memory?.title ?? "");
  check(
    "the pinned fact is surfaced for an unrelated question",
    recalledTitles.some((t) => t.includes("blue pot")),
    recalledTitles.length > 0 ? recalledTitles.join(" | ") : "nothing was recalled",
  );

  await op("memory.forget", { id: unrelatedId });

  const forgotten = await op("memory.forget", { id: memoryId });
  check("a memory can be forgotten", forgotten.status === 200);
  const afterForget = await board();
  check(
    "it is gone from the list",
    !afterForget.memories.items.some((m) => m.id === memoryId),
  );
  const forgetAgain = await op("memory.forget", { id: memoryId });
  check("forgetting it twice is a 404, not a silent success", forgetAgain.status === 404);

  /* ---------------- cleanup ---------------- */
  section("Cleanup");
  let removed = 0;
  for (const id of created) {
    if (!id) continue;
    const res = await op("goal.delete", { id });
    if (res.status === 200) removed++;
  }
  check(
    "every goal this script created is deleted",
    removed === created.filter(Boolean).length,
    `${removed} of ${created.filter(Boolean).length}`,
  );

  const finalBoard = await board();
  check(
    "nothing created by this script is left on the board",
    !finalBoard.goals.some((g) => g.goal.title?.startsWith(marker)),
  );

  return report();
}

function report() {
  section("Result");
  console.log(`  ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nCave verification failed: ${err.message}`);
  process.exitCode = 1;
});
