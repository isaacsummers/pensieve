// Faster-Whisper model identifiers supported by WhisperX.
// WhisperX/faster-whisper downloads and caches these automatically on first
// use (no manual URLs or .bin files to track).
export const modelData = [
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large-v1",
  "large-v2",
  "large-v3",
  "distil-large-v3",
].reduce(
  (acc, name) => {
    acc[name] = { name };
    return acc;
  },
  {} as Record<string, { name: string }>,
);

export type WhisperxModelId = keyof typeof modelData;
