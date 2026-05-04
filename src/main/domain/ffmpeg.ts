import { execa } from "execa";
import path from "path";
import os from "os";
import fs from "fs";
import { dialog, shell } from "electron";
import {
  getExtraResourcesFolder,
  getMillisecondsFromTimeString,
} from "../../main-utils";
import * as runner from "./runner";
import * as settings from "./settings";

// --- autodetection --------------------------------------------------------

export type FfmpegSource =
  | "bundled" // extra/ffmpeg.exe (Windows bundle)
  | "installed" // C:\ffmpeg\... or /opt/homebrew/... (user-installed, absolute)
  | "path" // resolved via system PATH
  | "configured" // user-provided via settings.ffmpeg.binaryPath
  | "missing";

export type FfmpegStatus = {
  ok: boolean;
  path: string | null;
  source: FfmpegSource;
  version: string | null;
  error?: string;
};

const tryVersion = async (
  exe: string,
): Promise<{ ok: boolean; version: string | null; error?: string }> => {
  try {
    const r = await execa(exe, ["-version"], {
      stdio: "pipe",
      timeout: 10_000,
      reject: false,
    });
    if (r.exitCode === 0) {
      const v = /ffmpeg version (\S+)/i.exec(r.stdout + r.stderr)?.[1] ?? null;
      return { ok: true, version: v };
    }
    return {
      ok: false,
      version: null,
      error: `ffmpeg exited ${r.exitCode}`,
    };
  } catch (err) {
    return {
      ok: false,
      version: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

/**
 * Build the ordered list of candidate ffmpeg locations for the current
 * platform. On Windows the priority mirrors Isaac's typical layout:
 *   1. extra/ffmpeg.exe (bundled with the app)
 *   2. C:\ffmpeg\bin\ffmpeg.exe (standard manual install)
 *   3. C:\ffmpeg\ffmpeg.exe (flattened manual install)
 *   4. PATH resolution (final fallback)
 *
 * On macOS/Linux we check Homebrew / system paths and PATH.
 */
const buildCandidates = (): Array<{ path: string; source: FfmpegSource }> => {
  if (os.platform() === "win32") {
    return [
      {
        path: path.join(getExtraResourcesFolder(), "ffmpeg.exe"),
        source: "bundled",
      },
      { path: "C:\\ffmpeg\\bin\\ffmpeg.exe", source: "installed" },
      { path: "C:\\ffmpeg\\ffmpeg.exe", source: "installed" },
      { path: "ffmpeg", source: "path" },
    ];
  }
  return [
    { path: path.join(getExtraResourcesFolder(), "ffmpeg"), source: "bundled" },
    { path: "/opt/homebrew/bin/ffmpeg", source: "installed" },
    { path: "/usr/local/bin/ffmpeg", source: "installed" },
    { path: "/usr/bin/ffmpeg", source: "installed" },
    { path: "ffmpeg", source: "path" },
  ];
};

/**
 * Detect the active ffmpeg binary. Honors an explicit
 * `settings.ffmpeg.binaryPath` override first, then walks the candidate list.
 * Returns a status object suitable for rendering in the settings UI.
 */
export const detectFfmpeg = async (): Promise<FfmpegStatus> => {
  // 1. Explicit settings override takes precedence.
  const s = await settings.getSettings();
  const configured = s.ffmpeg?.binaryPath?.trim();
  if (configured) {
    // Absolute path must exist; bare command is validated via -version.
    const isPath = path.isAbsolute(configured);
    if (!isPath || fs.existsSync(configured)) {
      const v = await tryVersion(configured);
      if (v.ok) {
        return {
          ok: true,
          path: configured,
          source: "configured",
          version: v.version,
        };
      }
    }
  }

  // 2. Walk candidates in priority order.
  for (const { path: exe, source } of buildCandidates()) {
    // For absolute paths, skip if the file doesn't exist — avoids spawning
    // a failing process for every non-existent candidate.
    if (path.isAbsolute(exe) && !fs.existsSync(exe)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const v = await tryVersion(exe);
    if (v.ok) {
      return { ok: true, path: exe, source, version: v.version };
    }
  }

  return {
    ok: false,
    path: null,
    source: "missing",
    version: null,
    error: "ffmpeg not found in extra/, C:\\ffmpeg, or PATH",
  };
};

// Show warning dialog for missing FFmpeg (macOS only)
const showFFmpegWarning = async () => {
  if (os.platform() !== "darwin") {
    return; // Only show on macOS
  }

  const result = await dialog.showMessageBox({
    type: "warning",
    title: "FFmpeg Not Found",
    message: "FFmpeg is required but not found on your system.",
    detail:
      "Please install FFmpeg using one of these methods:\n\n" +
      "• Homebrew: brew install ffmpeg\n" +
      "• Download from: https://ffmpeg.org/download.html\n\n" +
      "Pensieve will not work properly without FFmpeg.",
    buttons: ["OK", "Open FFmpeg Website"],
    defaultId: 0,
  });

  if (result.response === 1) {
    shell.openExternal("https://ffmpeg.org/download.html");
  }
};

// Cached resolution for hot-path callers. The settings UI uses detectFfmpeg()
// directly to see fresh state after a "Use existing" / "Download" action.
let cachedPath: string | null = null;
let cachedStatus: FfmpegStatus | null = null;
let ffmpegChecked = false;
let ffmpegCheckInFlight: Promise<void> | null = null;

const resolveFfmpegPath = async (): Promise<string> => {
  if (cachedPath) return cachedPath;
  const status = await detectFfmpeg();
  cachedStatus = status;
  cachedPath = status.ok && status.path ? status.path : "ffmpeg";
  return cachedPath;
};

export const invalidateFfmpegCache = () => {
  cachedPath = null;
  cachedStatus = null;
  // Re-arm the one-time availability check so a subsequent call re-detects
  // (including re-firing the macOS install dialog if the new path is bad).
  ffmpegChecked = false;
  ffmpegCheckInFlight = null;
};

export const getCachedFfmpegStatus = (): FfmpegStatus | null => cachedStatus;

// Initialize FFmpeg check on module load. We share the in-flight promise so
// concurrent callers don't double-run detection, and we only mark the check
// as complete once it actually resolves — so a thrown check doesn't
// permanently poison subsequent callers.
const ensureFFmpegAvailable = async (): Promise<void> => {
  if (ffmpegChecked) return;
  if (ffmpegCheckInFlight) {
    await ffmpegCheckInFlight;
    return;
  }
  ffmpegCheckInFlight = (async () => {
    const status = await detectFfmpeg();
    cachedStatus = status;
    cachedPath = status.ok && status.path ? status.path : "ffmpeg";
    if (!status.ok && os.platform() === "darwin") {
      await showFFmpegWarning();
    }
    ffmpegChecked = true;
  })();
  try {
    await ffmpegCheckInFlight;
  } finally {
    ffmpegCheckInFlight = null;
  }
};

// --- "use existing" + download helpers ------------------------------------

/**
 * Copy an externally-detected ffmpeg binary into the app's extra/ folder so
 * the bundled-path resolver finds it. Used by the settings "Use existing"
 * action when the user has ffmpeg installed outside extra/.
 */
export const adoptExternalFfmpeg = async (
  sourcePath: string,
): Promise<{ ok: boolean; target?: string; error?: string }> => {
  try {
    if (!fs.existsSync(sourcePath)) {
      return { ok: false, error: `source not found: ${sourcePath}` };
    }
    const extraDir = getExtraResourcesFolder();
    fs.mkdirSync(extraDir, { recursive: true });
    const target = path.join(
      extraDir,
      os.platform() === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
    fs.copyFileSync(sourcePath, target);
    if (os.platform() !== "win32") {
      fs.chmodSync(target, 0o755);
    }
    invalidateFfmpegCache();
    return { ok: true, target };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

// --- ffmpeg operations ----------------------------------------------------

export const simpleTranscode = async (input: string, output: string) => {
  await ensureFFmpegAvailable();
  const bin = await resolveFfmpegPath();
  await execa(bin, ["-i", input, "-y", output], {
    stdio: "inherit",
  });
};

export const toWavFile = async (input: string, output: string) => {
  await ensureFFmpegAvailable();
  const bin = await resolveFfmpegPath();
  await execa(bin, ["-i", input, "-ac", "2", "-y", "-ar", "16000", output], {
    stdio: "inherit",
  });
};

export const toStereoWavFile = async (
  input1: string,
  input2: string,
  output: string,
) => {
  await ensureFFmpegAvailable();
  const bin = await resolveFfmpegPath();
  // Normalize both input streams to a stereo layout *before* merging so the
  // downstream pan mapping (which references c0..c3) always has four source
  // channels to pull from. Without this, a mono + stereo pairing silently
  // produces wrong audio because `c2`/`c3` do not exist on the mono side.
  // The hardcoded filter mirrors the fix applied to `toJoinedFile`.
  const filter =
    "[0:a]aformat=channel_layouts=stereo[a0];" +
    "[1:a]aformat=channel_layouts=stereo[a1];" +
    "[a0][a1]amerge=inputs=2," +
    "pan=stereo|c0<c0+c1|c1<c2+c3," +
    "highpass=f=300,lowpass=f=3000[a]";
  await runner.execute(
    bin,
    [
      "-i",
      input1,
      "-i",
      input2,
      "-filter_complex",
      filter,
      "-map",
      "[a]",
      "-ar",
      "16000",
      "-y",
      output,
    ],
    { stdio: "inherit" },
  );
};

export const toJoinedFile = async (
  input1: string | null,
  input2: string | null,
  output: string,
) => {
  await ensureFFmpegAvailable();
  const bin = await resolveFfmpegPath();
  if (!input1 && !input2) {
    throw new Error("No input files");
  }

  if (input1 && input2) {
    await runner.execute(
      bin,
      [
        "-i",
        input1,
        "-i",
        input2,
        "-filter_complex",
        "[0:a]aformat=channel_layouts=stereo[a0];[1:a]aformat=channel_layouts=stereo[a1];[a0][a1]amix=inputs=2:duration=longest[aout]",
        "-map",
        "[aout]",
        "-y",
        output,
      ],
      { stdio: "inherit" },
    );
  } else {
    await execa(bin, ["-i", (input1 ?? input2)!, "-y", output], {
      stdio: "inherit",
    });
  }
};

export const getDuration = async (input: string) => {
  await ensureFFmpegAvailable();
  const bin = await resolveFfmpegPath();
  const { stdout, stderr } = await runner.execute(
    bin,
    ["-i", input, "-f", "null", "-"],
    {
      stdout: "pipe",
    },
  );
  const match = (stderr || stdout).match(
    /duration\s*:?\s(\d{2}:\d{2}:\d{2}.\d{2})/i,
  );
  const time = match?.[1];
  if (!time) {
    return 0;
  }
  return getMillisecondsFromTimeString(time!);
};
