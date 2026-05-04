import fs from "fs-extra";
import path from "path";
import { app } from "electron";
import { getSettings } from "./settings";
import * as postprocess from "./postprocess";

// WhisperX / faster-whisper caches models under the user's HuggingFace cache
// (typically ~/.cache/huggingface or ~/.cache/whisper). Pensieve no longer
// manages model downloads directly — the first transcription run that
// references a new model will download it.
export const getModelCacheFolder = () => {
  // This is informational only; used by the settings UI to surface "open
  // cache folder" action. WhisperX itself respects HF_HOME / TRANSFORMERS_CACHE
  // etc., so this is just a best-effort default pointer.
  const home = app.getPath("home");
  const candidates = [
    path.join(home, ".cache", "huggingface"),
    path.join(home, ".cache", "whisper"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0];
};

export const prepareConfiguredModel = async () => {
  const { model } = (await getSettings()).whisperx;
  // WhisperX handles model download/caching on its own. We just surface the
  // current "modelDownload" step as complete so the existing progress UI
  // keeps rendering sensibly.
  postprocess.setProgress("modelDownload", 1);
  return model;
};
