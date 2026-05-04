// Model management used to expose downloadModel/listModels for whisper.cpp
// ggml binaries. With WhisperX, faster-whisper handles its own cache, so the
// IPC surface is now a no-op placeholder kept to avoid breaking existing
// IPC registrations. The renderer no longer calls these.
export const modelsApi = {
  // Retained as a stub so existing wiring still resolves. Returns an empty
  // list; WhisperX fetches models transparently on first use.
  listModels: async (): Promise<string[]> => [],
};
