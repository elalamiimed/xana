/**
 * The pass that lets her speak first.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/schedule.ts
 *   node --import ./scripts/ts-loader.mjs scripts/schedule.ts --dry-run
 *   node --import ./scripts/ts-loader.mjs scripts/schedule.ts --json
 *   node --import ./scripts/ts-loader.mjs scripts/schedule.ts --budget 1
 *
 * WHAT THIS IS FOR
 *
 * Xana had a decision layer for speaking unprompted - `derived/proactive.ts`
 * scores relevance against the cost of interrupting, with quiet hours, a daily
 * budget and a reason for every verdict - and nothing ever called it. She never
 * said anything first. This script calls it.
 *
 * It is meant to be run by whatever already runs things on your machine:
 *
 *   Windows Task Scheduler, every two hours between 08:00 and 21:00:
 *     Program:   node
 *     Arguments: --import ./scripts/ts-loader.mjs scripts/schedule.ts
 *     Start in:  C:\path\to\Xana
 *
 *   cron, hourly, silent when there is nothing to say:
 *     0 8-21 * * * cd /path/to/Xana && node --import ./scripts/ts-loader.mjs scripts/schedule.ts
 *
 * WHY NOT A TIMER INSIDE THE APP
 *
 * Three reasons, and they are the reason this is a script rather than a
 * `setInterval` in the Next process: a timer there does not survive a module
 * reload or a restart and stops silently; it wakes in parallel with request
 * handlers against a single SQLite writer and spends `busy_timeout` for nothing;
 * and "why did she say that at 3am" becomes unanswerable once the process that
 * decided it is gone.
 *
 * WHAT IT PRINTS, AND WHY THAT MATTERS
 *
 * The default output is the sentences, one per line, so a caller can pipe it
 * somewhere. `--json` gives the whole decision record including every candidate
 * that was suppressed and why - which is the difference between "she had nothing
 * to say" and "she had something to say and the budget was spent", and only one
 * of those is a bug.
 *
 * EXIT CODES
 *
 *   0  ran, and either had something to say or correctly had nothing
 *   1  the pass failed (a database that will not open, a life state that will
 *      not assemble) - so a scheduler can surface it rather than swallowing it
 *
 * It never exits non-zero for "nothing to say". A quiet assistant is a working
 * assistant, and a cron job that emails on silence gets muted on day two.
 */

import { getStore } from "../src/lib/core/store";
import { buildLifeState } from "../src/lib/context/gateway";
import { runCheckIn, describeCheckIn } from "../src/lib/derived/checkin";

interface Args {
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
  budget?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--json") args.json = true;
    else if (a === "--quiet" || a === "-q") args.quiet = true;
    else if (a === "--budget") {
      const value = Number(argv[i + 1]);
      // A budget of zero is a legitimate way to ask "what would you say", so it
      // is honoured rather than treated as a missing value.
      if (Number.isFinite(value) && value >= 0) args.budget = Math.floor(value);
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

try {
  const state = await buildLifeState();
  const result = runCheckIn(state, {
    dryRun: args.dryRun,
    ...(args.budget !== undefined ? { budgetPerDay: args.budget } : {}),
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (args.quiet) {
    // Nothing at all: for a scheduler whose only job is the side effect.
    for (const item of result.deliver) process.stdout.write(`${item.text}\n`);
  } else {
    process.stdout.write(`${describeCheckIn(result)}\n`);
    if (args.dryRun) process.stdout.write("(dry run - nothing recorded)\n");
  }

  // The store is closed explicitly so the write-ahead log is folded back and the
  // next scheduled run finds a complete database, exactly as `dev.mjs` does on
  // shutdown.
  getStore().close();
} catch (err) {
  process.stderr.write(`schedule: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
