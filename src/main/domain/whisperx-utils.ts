/**
 * Pure helpers used by the WhisperX pipeline.
 *
 * This module is intentionally electron-free so its contents can be unit
 * tested under plain Node. Anything that reaches into `app`, `dialog`,
 * `shell`, or filesystem-side effects belongs in `whisperx.ts`, not here.
 */
import { RecordingTranscript } from "../../types-pure";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export const toHms = (seconds: number): string => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(r, 3)}`;
};

/**
 * Normalize a WhisperX diarizer speaker label to a stable key.
 *
 * Returns `null` for absent / empty / non-digit labels so the caller can
 * decide what to do (e.g. drop the segment from embedding grouping instead
 * of collapsing unknowns into speaker 0).
 */
export const normalizeSpeaker = (label?: unknown): string | null => {
  if (label === null || label === undefined) return null;
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  if (!trimmed) return null;
  const match = /(\d+)/.exec(trimmed);
  return match ? String(parseInt(match[1], 10)) : null;
};

export type WhisperxSegment = {
  start?: number;
  end?: number;
  text?: string;
  speaker?: string;
};

export type WhisperxJson = {
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
      const speaker = normalizeSpeaker(s.speaker);
      return {
        timestamps: { from: toHms(start), to: toHms(end) },
        offsets: {
          from: Math.round(start * 1000),
          to: Math.round(end * 1000),
        },
        text: String(s.text ?? "").trim(),
        // `null` normalized speakers are stored as an empty string on
        // transcript items so the existing UI keeps working; the embedding
        // pipeline drops them separately via its own filter (see
        // processWavFile).
        speaker: speaker ?? "",
      };
    }),
  };
};
