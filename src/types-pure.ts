/**
 * Electron-free type mirrors for cross-module consumers (including tests).
 *
 * `src/types.ts` imports `electron` at module load because it wires
 * `defaultSettings` to `app.getPath(...)`. Anything that only needs type
 * shapes should import from this file instead, so the import graph stays
 * electron-free and can be unit-tested under plain Node.
 */

export type RecordingTranscriptItem = {
  timestamps: { from: string; to: string };
  offsets: { from: number; to: number };
  text: string;
  speaker: string;
};

export type RecordingTranscript = {
  result: { language: string };
  transcription: RecordingTranscriptItem[];
};
