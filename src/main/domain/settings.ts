import fs from "fs-extra";
import path from "path";
import os from "os";
import { app } from "electron";
import { execa } from "execa";
import deepmerge from "deepmerge";
import type { DeepPartial } from "@tanstack/react-router/dist/esm/utils";
import { Settings, defaultSettings } from "../../types";
import { invalidateUiKeys } from "../ipc/invalidate-ui";
import { QueryKeys } from "../../query-keys";

const settingsFile = path.join(app.getPath("userData"), "settings.json");
let cachedSettings: Settings | null = null;

const readSettings = async (
  fallback: Settings | {},
): Promise<Settings | {}> => {
  try {
    return fs.existsSync(settingsFile) ? await fs.readJSON(settingsFile) : {};
  } catch (e) {
    console.error("Error reading settings file, using fallback", e);
    return fallback;
  }
};

const hasNvidiaGpu = async (): Promise<boolean> => {
  if (process.platform === "win32" && process.env.CUDA_PATH?.trim()) {
    return true;
  }
  try {
    const r = await execa("nvidia-smi", ["-L"], {
      stdio: "pipe",
      timeout: 5_000,
      reject: false,
    });
    return r.exitCode === 0 && /GPU\s+\d+/.test(r.stdout || "");
  } catch {
    return false;
  }
};

const hasAppleSiliconMps = (): boolean =>
  process.platform === "darwin" && os.arch() === "arm64";

/**
 * On first launch we probe the host for a usable accelerator and pre-seed
 * safe whisperx defaults so the user doesn't hit a CUDA/float16 crash on
 * a CPU-only box or on macOS. The base defaults in `types.ts` stay CPU+int8;
 * this only flips them when we positively detect NVIDIA (preferred) or
 * Apple Silicon MPS. Any later user edit via the settings UI takes over.
 */
const detectInitialAcceleratorDefaults = async (): Promise<
  DeepPartial<Settings>
> => {
  try {
    if (await hasNvidiaGpu()) {
      return { whisperx: { device: "cuda", computeType: "float16" } };
    }
    if (hasAppleSiliconMps()) {
      // MPS in faster-whisper is still rough; we keep compute_type safe.
      return { whisperx: { device: "mps", computeType: "float32" } };
    }
  } catch {
    /* fall through to CPU defaults */
  }
  return {};
};

export const initSettingsFile = async () => {
  if (!fs.existsSync(settingsFile)) {
    const seed = await detectInitialAcceleratorDefaults();
    await fs.promises.writeFile(settingsFile, JSON.stringify(seed, null, 2), {
      encoding: "utf-8",
    });
  }
};

export const existsSettingsFile = () => fs.existsSync(settingsFile);

export const getSettings = async () => {
  if (cachedSettings) {
    return cachedSettings;
  }

  try {
    const merged = deepmerge(defaultSettings, await readSettings({}));
    cachedSettings = merged;
    return merged;
  } catch (e) {
    console.error(
      "Error merging settings while reading, using default settings",
      e,
    );
    return defaultSettings;
  }
};

export const saveSettings = async (partialSettings: DeepPartial<Settings>) => {
  if (partialSettings.core?.recordingsFolder) {
    await fs.ensureDir(partialSettings.core.recordingsFolder);
  }
  const settings = await readSettings({});
  const merged = deepmerge(settings, partialSettings);
  await fs.writeJSON(settingsFile, merged, {
    spaces: 2,
  });
  cachedSettings = deepmerge(
    deepmerge(cachedSettings ?? {}, defaultSettings),
    merged,
  ) as Settings;
  await invalidateUiKeys(QueryKeys.Settings);
  if (partialSettings.ui?.dark !== undefined) {
    await invalidateUiKeys(QueryKeys.Theme);
  }
};

export const reset = async () => {
  await fs.remove(settingsFile);
  cachedSettings = null;
  await invalidateUiKeys(QueryKeys.Settings);
  await invalidateUiKeys(QueryKeys.Theme);
};
