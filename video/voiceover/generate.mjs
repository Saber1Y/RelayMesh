// Generates every voiceover line with VoiceStudio's local API (The Neighbor) and writes
// manifest.json with each line's duration, so the motion intro can be timed to it.
//
// Long inputs come out garbled, so each line is spoken one sentence at a time and the sentences
// are joined with a short pause.
//
//   node video/voiceover/generate.mjs            # all missing lines
//   node video/voiceover/generate.mjs intro-03   # regenerate one line
//   node video/voiceover/generate.mjs --tighten  # re-tighten every existing line without regenerating
//
// Every line is tightened: dead air trimmed from both ends, and pauses inside it capped, so the
// narration sounds compact.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The rendered videos read the audio from public/, where Remotion serves static files.
const out = join(here, "..", "public", "voiceover");
const API = process.env.VOICESTUDIO_URL ?? "http://127.0.0.1:3900";
const PAUSE_SECONDS = 0.12;
/** Pauses inside a line longer than this are shortened to it. */
const MAX_PAUSE_SECONDS = 0.15;
// Low enough that soft word starts ("our", "MON") are never mistaken for silence.
const SILENCE = "-55dB";
const { voice, lines } = JSON.parse(readFileSync(join(here, "lines.json"), "utf8"));
const args = process.argv.slice(2);
const tightenOnly = args.includes("--tighten");
const only = new Set(args.filter((a) => !a.startsWith("--")));

/**
 * Trims silence at both ends (keeping 40 ms so words never clip) and caps every pause inside the
 * line at MAX_PAUSE_SECONDS. Idempotent: tightening a tightened file changes nothing.
 */
function tighten(file) {
  const tmp = `${file}.tight.wav`;
  const trim = `silenceremove=start_periods=1:start_threshold=${SILENCE}:start_silence=0.04`;
  const filter = [
    trim,
    "areverse",
    trim,
    "areverse",
    `silenceremove=stop_periods=-1:stop_duration=${MAX_PAUSE_SECONDS}:stop_threshold=${SILENCE}:stop_silence=${MAX_PAUSE_SECONDS}`,
  ].join(",");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-af", filter, "-c", "pcm_s16le", tmp]);
  execFileSync("mv", [tmp, file]);
}

function seconds(file) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
}

/** Sentences, keeping their punctuation; very short fragments stay with their neighbour. */
function sentences(text) {
  const parts = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  return parts.reduce((acc, s) => {
    if (acc.length && (s.split(" ").length < 3 || acc[acc.length - 1].split(" ").length < 3)) acc[acc.length - 1] += ` ${s}`;
    else acc.push(s);
    return acc;
  }, []);
}

async function speak(text, file) {
  const res = await fetch(`${API}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "omnivoice", input: text, voice: "default", instruct: voice.instruct, seed: voice.seed, response_format: "wav" }),
  });
  if (!res.ok) throw new Error(`VoiceStudio answered ${res.status} ${await res.text()}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const manifest = {};
for (const line of lines) {
  const file = join(out, `${line.id}.wav`);
  if (only.size ? only.has(line.id) : !existsSync(file)) {
    const dir = mkdtempSync(join(tmpdir(), "vo-"));
    // `whole` lines are short taglines that sound better spoken in one breath.
    const parts = line.whole ? [line.text] : sentences(line.text);
    const files = [];
    for (const [i, text] of parts.entries()) {
      const part = join(dir, `${i}.wav`);
      await speak(text, part);
      files.push(part);
    }
    // Join the sentences with a short pause, at the engine's 24 kHz mono.
    const silence = join(dir, "pause.wav");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `anullsrc=r=24000:cl=mono`, "-t", String(PAUSE_SECONDS), silence]);
    const list = join(dir, "list.txt");
    writeFileSync(list, files.flatMap((f, i) => (i ? [silence, f] : [f])).map((f) => `file '${f}'`).join("\n"));
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "pcm_s16le", file]);
    rmSync(dir, { recursive: true, force: true });
    tighten(file);
    console.log(`generated ${line.id} (${parts.length} sentence${parts.length === 1 ? "" : "s"})`);
  } else if (tightenOnly && existsSync(file)) {
    tighten(file);
  }
  manifest[line.id] = { file: `voiceover/${line.id}.wav`, seconds: Math.round(seconds(file) * 100) / 100, text: line.text };
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(Object.entries(manifest).map(([id, m]) => `${id} ${m.seconds}s`).join("\n"));
