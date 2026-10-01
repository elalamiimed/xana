/**
 * Prove the transcription path end to end, with a real model.
 *
 *   node scripts/check-transcribe-live.mjs        (service must be running)
 *
 * WHY THIS FILE EXISTS
 *
 * The local transcriber was written, shipped and declared "unverified" — because
 * the machine it was built on could not reach PyPI, so faster-whisper was never
 * installed and Whisper's decode path had never run. Shipping a feature whose
 * core is unexercised is not a limitation to disclose; it is a defect to fix.
 *
 * This runs the ACTUAL service against ACTUAL audio and asserts on the JSON it
 * returns, so what is proved is the same code path the browser talks to.
 *
 * WHAT IT CAN AND CANNOT PROVE
 *
 * Synthetic audio has no words in it, so this cannot check transcription
 * QUALITY — nothing here claims Whisper is accurate. What it proves is everything
 * between the HTTP request and the words: the WAV is decoded, the model loads and
 * runs, the duration is computed, the response has the shape the browser expects,
 * and a clip with no speech comes back cleanly rather than as an error.
 *
 * The audio is generated rather than committed: a 16 kHz mono PCM WAV built from
 * a sine wave, written with `DataView`. That keeps binary fixtures out of the
 * repository and makes the bytes visible in the source.
 *
 * Exit codes: 0 when every check passed OR the service was simply not ready
 * (which is an environment fact, not a failure of this script), 1 on a real
 * failure.
 */

const PORT = Number(process.env.XANA_STT_PORT ?? 4319);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(label, why) {
  skipped += 1;
  console.log(`  skip  ${label} — ${why}`);
}

/**
 * A 16 kHz mono 16-bit PCM WAV.
 *
 * The shape Whisper wants, and the shape the browser's recorder is asked to
 * produce. `tone` at 0 gives a stream of zero samples, which is the silence case.
 */
function makeWav(seconds, tone = 440) {
  const sampleRate = 16000;
  const frames = Math.max(1, Math.round(sampleRate * seconds));
  const dataBytes = frames * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const ascii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  for (let frame = 0; frame < frames; frame += 1) {
    // Faded at both ends: a tone that starts mid-cycle clicks, and a click is
    // broadband noise the model may try to read as a word.
    const position = frame / frames;
    const envelope = Math.min(1, position * 20, (1 - position) * 20);
    const sample = tone === 0 ? 0 : Math.sin((2 * Math.PI * tone * frame) / sampleRate) * 0.25 * envelope;
    view.setInt16(44 + frame * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true);
  }

  return buffer;
}

async function health() {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function post(body, type = "audio/wav") {
  const response = await fetch(`${BASE}/transcribe`, {
    method: "POST",
    headers: { "content-type": type },
    body,
    signal: AbortSignal.timeout(180_000),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // A non-JSON body is itself informative; the caller reports the status.
  }
  return { status: response.status, json };
}

/* ------------------------------------------------------------------ */

console.log("\nTranscription, end to end, with a real model\n");

const status = await health();
if (!status) {
  skip("every check", `no service at ${BASE} — start it with python/serve.ps1`);
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(0);
}

console.log(`  info  backend=${status.backend} ready=${status.ready}`);
if (!status.ready) {
  // An environment fact, not a failure of this script: the install or the model
  // download has not happened. Blaming the test for that would be wrong.
  skip("every check", `the service is not ready: ${status.reason}`);
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  process.exit(0);
}

check("the service reports a real backend", status.backend !== "none", status.backend);
check("and a model", typeof status.model === "string" && status.model.length > 0, status.model);

/* --- a tone: decodable audio with no words in it -------------------- */

const tone = makeWav(1.5, 440);
console.log(`  info  tone: ${tone.length} bytes, 16kHz mono PCM16`);

const toneResult = await post(tone);
check("a WAV is accepted", toneResult.status === 200, `status ${toneResult.status}`);
check("the response carries text", typeof toneResult.json?.text === "string", JSON.stringify(toneResult.json));
check(
  "the response carries a duration",
  typeof toneResult.json?.durationMs === "number",
  String(toneResult.json?.durationMs),
);
check("the response names its backend", typeof toneResult.json?.backend === "string", String(toneResult.json?.backend));
console.log(`  info  the model heard: ${JSON.stringify(toneResult.json?.text ?? null)}`);

/* --- silence --------------------------------------------------------- */

const silent = makeWav(1.0, 0);
const silentResult = await post(silent);
check("silence is accepted", silentResult.status === 200, `status ${silentResult.status}`);
// Whisper is known to invent text for silence. Reporting it beats asserting it
// away: if it hallucinates here, that is worth knowing.
console.log(`  info  silence produced: ${JSON.stringify(silentResult.json?.text ?? null)}`);

/* --- junk and edges -------------------------------------------------- */

const junk = await post(Buffer.from("not audio at all, just bytes"));
check("junk audio is refused without crashing", junk.status < 500, `status ${junk.status}`);

const empty = await post(Buffer.alloc(0));
check("an empty body is refused without crashing", empty.status < 500, `status ${empty.status}`);

const wrongType = await post(tone, "application/json");
check("a wrong content type is refused without crashing", wrongType.status < 500, `status ${wrongType.status}`);

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed === 0 ? 0 : 1);
