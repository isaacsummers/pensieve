import path from "path";
import os from "os";
import fs from "fs-extra";
import { dialog, shell } from "electron";
import log from "electron-log/main";
import { buildArgs, getMillisecondsFromTimeString } from "../../main-utils";
import * as ffmpeg from "./ffmpeg";
import * as runner from "./runner";
import * as postprocess from "./postprocess";
import * as speakerProfiles from "./speaker-profiles";
import { getSettings } from "./settings";
import { RecordingTranscript } from "../../types";

// --- Transcript transform ----------------------------------------------------
//
// The pure helpers (toHms, normalizeSpeaker, whisperxToTranscript) live in
// `./whisperx-utils` so they can be unit-tested under plain Node without
// loading electron. Re-export them here to keep the public module surface
// stable for existing callers.
import {
  type WhisperxJson,
  normalizeSpeaker as _normalizeSpeaker,
  toHms as _toHms,
  whisperxToTranscript as _whisperxToTranscript,
} from "./whisperx-utils";

// --- Availability / setup helpers --------------------------------------------

type WhisperxSettings = Awaited<ReturnType<typeof getSettings>>["whisperx"];

const getCommand = (
  settings: Pick<WhisperxSettings, "executable" | "pythonPath">,
): { cmd: string; prefix: string[] } => {
  if (settings.pythonPath && settings.pythonPath.trim()) {
    return { cmd: settings.pythonPath.trim(), prefix: ["-m", "whisperx"] };
  }
  return {
    cmd: (settings.executable && settings.executable.trim()) || "whisperx",
    prefix: [],
  };
};

export const checkWhisperxAvailability = async (): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
}> => {
  try {
    const settings = (await getSettings()).whisperx;
    const { cmd, prefix } = getCommand(settings);
    const { execa } = await import("execa");
    const result = await execa(cmd, [...prefix, "--help"], {
      stdio: "pipe",
      timeout: 10_000,
      reject: false,
    });
    if (result.exitCode === 0) {
      const version = /whisperx\s+([\d.]+)/i.exec(
        result.stdout + result.stderr,
      )?.[1];
      return { ok: true, version };
    }
    return {
      ok: false,
      error: `whisperx --help exited with code ${result.exitCode}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const showWhisperxWarning = async () => {
  const isWindows = os.platform() === "win32";
  const install = isWindows
    ? "  uv tool install whisperx\n  (or)  uv pip install whisperx\n"
    : "  pipx install whisperx\n  (or)  uv tool install whisperx\n";
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "WhisperX not found",
    message: "Pensieve could not find a working WhisperX installation.",
    detail:
      `Install WhisperX and ensure it is on PATH (or point to it under ` +
      `Settings → Audio Transcription):\n\n${install}\nFor diarization you will also need to accept the pyannote terms on ` +
      `Hugging Face and paste a HF token into Pensieve.`,
    buttons: ["OK", "Open WhisperX website"],
    defaultId: 0,
  });
  if (result.response === 1) {
    shell.openExternal("https://github.com/m-bain/whisperX");
  }
};

let whisperxChecked = false;
let whisperxCheckInFlight: Promise<void> | null = null;
const ensureWhisperxAvailable = async (): Promise<void> => {
  if (whisperxChecked) return;
  if (whisperxCheckInFlight) {
    await whisperxCheckInFlight;
    return;
  }
  whisperxCheckInFlight = (async () => {
    const result = await checkWhisperxAvailability();
    if (!result.ok) {
      log.warn("WhisperX availability check failed:", result.error);
      await showWhisperxWarning();
    }
    // Only mark as checked after the probe actually resolves, so a
    // throw/crash doesn't permanently suppress the warning dialog.
    whisperxChecked = true;
  })();
  try {
    await whisperxCheckInFlight;
  } finally {
    whisperxCheckInFlight = null;
  }
};

// --- HF auth error surfacing -------------------------------------------------
//
// When diarization is enabled and the HF token is missing / invalid,
// pyannote returns 401/403 from Hugging Face. We scan the WhisperX stderr
// stream for those signals and expose them via an IPC-queryable state so
// the settings UI can surface a clear call-to-action (accept pyannote
// terms, mint a token).

export type HfAuthErrorState = {
  at: string;
  reason: string;
  detail: string;
} | null;

let lastHfAuthError: HfAuthErrorState = null;

export const getLastHfAuthError = (): HfAuthErrorState => lastHfAuthError;

export const clearLastHfAuthError = (): void => {
  lastHfAuthError = null;
};

const detectHfAuthFailure = (
  text: string,
): { reason: string; detail: string } | null => {
  // Common shapes seen in pyannote / huggingface_hub errors:
  //   "401 Client Error", "HTTP Error 401", "GatedRepoError",
  //   "is not authorized to access", "Invalid user token".
  if (/\b401\b/.test(text) || /\b403\b/.test(text)) {
    const line = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /401|403/.test(l));
    return {
      reason: /403/.test(text) ? "forbidden" : "unauthorized",
      detail: line ?? text.slice(0, 500),
    };
  }
  if (
    /GatedRepoError|accept the (pyannote )?terms|is not authorized to access|Invalid user token/i.test(
      text,
    )
  ) {
    return {
      reason: "gated",
      detail: text.slice(0, 500),
    };
  }
  return null;
};

export const toHms = _toHms;
export const normalizeSpeaker = _normalizeSpeaker;
export const whisperxToTranscript = _whisperxToTranscript;

// --- Main entry point --------------------------------------------------------

export const processWavFile = async (
  input: string,
  output: string,
  modelId: string,
): Promise<{
  transcript: RecordingTranscript;
  segments: Array<{ speaker: string; start: number; end: number }>;
}> => {
  await ensureWhisperxAvailable();
  postprocess.setStep("whisper");

  const settings = (await getSettings()).whisperx;
  const outDir = path.dirname(output);
  const inputTime = await ffmpeg.getDuration(input);

  if (settings.diarize && !settings.hfToken.trim()) {
    throw new Error(
      "WhisperX diarization is enabled but no Hugging Face token is set. " +
        "Add one under Settings → Audio Transcription, or disable diarization.",
    );
  }

  await fs.ensureDir(outDir);

  const args = buildArgs({
    _0: input,
    model: modelId,
    output_dir: outDir,
    output_format: "json",
    compute_type: settings.computeType,
    device: settings.device,
    batch_size: settings.batchSize,
    language: settings.language === "auto" ? false : settings.language,
    task: settings.translate ? "translate" : false,
    diarize: settings.diarize,
    hf_token: settings.diarize && settings.hfToken ? settings.hfToken : false,
    min_speakers:
      settings.minSpeakers && settings.minSpeakers > 0
        ? settings.minSpeakers
        : false,
    max_speakers:
      settings.maxSpeakers && settings.maxSpeakers > 0
        ? settings.maxSpeakers
        : false,
    vad_method: settings.vadMethod || false,
    no_align: !settings.alignOutput,
  });

  const { cmd, prefix } = getCommand(settings);
  const fullArgs = [...prefix, ...args];
  log.info(
    `Running WhisperX: ${cmd} ${fullArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`,
  );

  const proc = runner.execute(cmd, fullArgs);

  let lastTqdmPct = 0;
  // Model download is surfaced as a distinct "modelDownload" step because
  // the first transcription pulls ~1GB with no other user feedback.
  // faster-whisper / huggingface_hub emit messages like
  //   "Downloading model.bin: 13%|..." or
  //   "Downloading (…) model.safetensors: 42%|..."
  // on stderr before transcription actually starts.
  let inModelDownload = false;
  let downloadPct = 0;
  const onChunk = (data: Buffer | string) => {
    const text = data.toString();

    // Capture HF auth errors as they stream in so we can surface them even
    // if WhisperX exits non-zero before we reach the parse step below.
    const auth = detectHfAuthFailure(text);
    if (auth) {
      lastHfAuthError = {
        at: new Date().toISOString(),
        reason: auth.reason,
        detail: auth.detail,
      };
    }

    // Model-download progress. The message distinguishes itself from
    // transcription progress via the word "Download". We pin modelDownload
    // progress to a separate step so the UI can render a dedicated spinner.
    const dlMatch = /Downloading[^\n]*?(\d{1,3})%/g.exec(text);
    if (dlMatch || /\bDownloading\b/.test(text)) {
      inModelDownload = true;
      if (dlMatch) {
        const pct = parseInt(dlMatch[1], 10);
        if (pct >= downloadPct) {
          downloadPct = pct;
          postprocess.setProgress("modelDownload", Math.min(1, pct / 100));
        }
      }
      return;
    }

    // tqdm progress bars (written to stderr by WhisperX / faster-whisper).
    const pctMatches = Array.from(text.matchAll(/(\d{1,3})%\|/g));
    if (pctMatches.length > 0) {
      // Once we see a non-download tqdm bar, the model is loaded; any
      // further percentages belong to transcription.
      if (inModelDownload && downloadPct < 100) {
        postprocess.setProgress("modelDownload", 1);
      }
      inModelDownload = false;
      const highest = Math.max(...pctMatches.map((m) => parseInt(m[1], 10)));
      if (highest >= lastTqdmPct) {
        lastTqdmPct = highest;
        postprocess.setProgress("whisper", Math.min(1, highest / 100));
      }
      return;
    }

    // Fallback: segment timestamps printed during alignment.
    const times = Array.from(
      text.matchAll(
        /\[\d{2}:\d{2}:\d{2}\.\d{3} --> (\d{2}:\d{2}:\d{2}\.\d{3})\]/g,
      ),
    ).map((m) => getMillisecondsFromTimeString(m[1]));
    if (times.length && inputTime) {
      const max = Math.max(...times);
      postprocess.setProgress("whisper", Math.min(1, max / inputTime));
    }
  };
  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);
  try {
    await proc;
  } catch (e) {
    // If we detected an HF 401/403 during this run, augment the thrown
    // error so the UI can surface the "accept pyannote terms / mint token"
    // flow without digging through stderr.
    if (lastHfAuthError) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `WhisperX diarization failed with a Hugging Face ${lastHfAuthError.reason} error. ` +
          `Accept the pyannote terms and provide a valid HF read token in settings. ` +
          `Underlying: ${msg}`,
      );
    }
    throw e;
  }
  // Only clear the auth error on a fully successful run. This way a
  // subsequent settings-panel query can still see the last auth failure
  // until the user fixes the token and runs again.
  if (settings.diarize && settings.hfToken.trim()) {
    lastHfAuthError = null;
  }

  // WhisperX writes <basename-without-ext>.json into --output_dir.
  const wxJsonPath = path.join(
    outDir,
    `${path.basename(input, path.extname(input))}.json`,
  );
  if (!fs.existsSync(wxJsonPath)) {
    let contents: string[] = [];
    try {
      contents = await fs.readdir(outDir);
    } catch {
      // ignore
    }
    throw new Error(
      `WhisperX finished but did not produce expected JSON at ${wxJsonPath}. ` +
        `Output dir contains: [${contents.join(", ")}]`,
    );
  }
  const wx = (await fs.readJSON(wxJsonPath)) as WhisperxJson;
  const transcript = whisperxToTranscript(wx);
  await fs.writeJSON(output, transcript);
  await fs.remove(wxJsonPath).catch(() => {});

  const rawSegments = Array.isArray(wx.segments) ? wx.segments : [];
  const segments = rawSegments
    .map((s) => ({ raw: s, speaker: normalizeSpeaker(s.speaker) }))
    .filter(
      ({ raw, speaker }) =>
        speaker !== null &&
        typeof raw.start === "number" &&
        typeof raw.end === "number" &&
        (raw.end as number) > (raw.start as number),
    )
    .map(({ raw, speaker }) => ({
      speaker: speaker as string,
      start: raw.start as number,
      end: raw.end as number,
    }));

  log.info("Processed WAV file via WhisperX");
  return { transcript, segments };
};

export const runSpeakerEmbeddingPipeline = async (params: {
  recordingId: string;
  audioPath: string;
  segments: Array<{ speaker: string; start: number; end: number }>;
}): Promise<{
  speakerEmbeddings?: Record<string, number[]>;
  speakerMatches?: Record<string, speakerProfiles.SpeakerMatch>;
  speakerNames?: Record<string, string>;
  pipelineError?: { stage: string; message: string } | null;
}> => {
  const settings = (await getSettings()).whisperx;
  if (!settings.embeddings?.enabled) {
    log.info("[embed] speaker embeddings disabled in settings; skipping");
    return {};
  }
  if (!settings.diarize) {
    log.info("[embed] diarization disabled; skipping embeddings");
    return {};
  }
  if (params.segments.length === 0) {
    log.warn("[embed] no segments to embed; skipping");
    return {};
  }

  try {
    const result = await speakerProfiles.extractEmbeddings({
      audioPath: params.audioPath,
      segments: params.segments,
    });
    const matches: Record<string, speakerProfiles.SpeakerMatch> = {};
    const names: Record<string, string> = {};
    const threshold = settings.embeddings.matchThreshold ?? 0.75;
    for (const [speakerKey, embedding] of Object.entries(result.embeddings)) {
      const match = await speakerProfiles.matchSpeaker(embedding, threshold);
      matches[speakerKey] = match;
      if (match.matched && match.profileName) {
        names[speakerKey] = match.profileName;
      }
    }
    return {
      speakerEmbeddings: result.embeddings,
      speakerMatches: matches,
      speakerNames: Object.keys(names).length ? names : undefined,
      pipelineError: null,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.error(
      `[embed] embedding pipeline failed for ${params.recordingId}: ${message}`,
    );
    // Degrade gracefully: keep the transcript + default SPEAKER_N labels but
    // record the error on the recording so the UI can surface it.
    return {
      pipelineError: { stage: "embed", message },
    };
  }
};
