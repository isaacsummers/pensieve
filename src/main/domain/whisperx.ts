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
const ensureWhisperxAvailable = async () => {
  if (whisperxChecked) return;
  whisperxChecked = true;
  const result = await checkWhisperxAvailability();
  if (!result.ok) {
    log.warn("WhisperX availability check failed:", result.error);
    await showWhisperxWarning();
  }
};

// --- Transcript transform ----------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export const toHms = (seconds: number): string => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(r, 3)}`;
};

export const normalizeSpeaker = (label?: unknown): string => {
  if (typeof label !== "string" || !label) return "0";
  const match = /(\d+)/.exec(label);
  return match ? String(parseInt(match[1], 10)) : "0";
};

type WhisperxSegment = {
  start?: number;
  end?: number;
  text?: string;
  speaker?: string;
};

type WhisperxJson = {
  segments?: WhisperxSegment[];
  language?: string;
};

export const whisperxToTranscript = (wx: WhisperxJson): RecordingTranscript => {
  const segments = Array.isArray(wx.segments) ? wx.segments : [];
  return {
    result: { language: wx.language ?? "auto" },
    transcription: segments.map((s) => {
      const start = typeof s.start === "number" ? s.start : 0;
      const end = typeof s.end === "number" ? s.end : start;
      return {
        timestamps: { from: toHms(start), to: toHms(end) },
        offsets: {
          from: Math.round(start * 1000),
          to: Math.round(end * 1000),
        },
        text: String(s.text ?? "").trim(),
        speaker: normalizeSpeaker(s.speaker),
      };
    }),
  };
};

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
  const onChunk = (data: Buffer | string) => {
    const text = data.toString();

    // tqdm progress bars (written to stderr by WhisperX / faster-whisper).
    const pctMatches = Array.from(text.matchAll(/(\d{1,3})%\|/g));
    if (pctMatches.length > 0) {
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
  await proc;

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
    .filter(
      (s) =>
        typeof s.start === "number" &&
        typeof s.end === "number" &&
        s.end > s.start,
    )
    .map((s) => ({
      speaker: normalizeSpeaker(s.speaker),
      start: s.start as number,
      end: s.end as number,
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
