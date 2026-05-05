import path from "path";
import fs from "fs-extra";
import { execa } from "execa";
import log from "electron-log/main";
import { getSettings } from "./settings";
import { getUvExecutable } from "../../main-utils";
import {
  ensureWhisperxProjectDir,
  getWhisperxVenvPython,
} from "./whisperx-venv";

// --- Types -------------------------------------------------------------------

export interface CudaHealthResult {
  hasNvidiaGpu: boolean;
  cudaDriverVersion: string | null;
  torchCudaAvailable: boolean;
  torchVersion: string | null;
  suggestedIndexUrl: string | null;
}

export interface CudaInstallState {
  inProgress: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  error: string | null;
  // Tail of streamed stdout/stderr so the UI can show recent progress lines.
  log: string;
}

const MAX_LOG_CHARS = 16_000;

let installState: CudaInstallState = {
  inProgress: false,
  startedAt: null,
  finishedAt: null,
  ok: null,
  error: null,
  log: "",
};

export const getCudaInstallState = (): CudaInstallState => ({
  ...installState,
});

const appendLog = (chunk: string) => {
  const next = (installState.log + chunk).slice(-MAX_LOG_CHARS);
  installState = { ...installState, log: next };
};

// --- nvidia-smi probe --------------------------------------------------------

const probeNvidiaSmi = async (): Promise<{
  hasGpu: boolean;
  driverCudaVersion: string | null;
}> => {
  // Presence check + GPU listing.
  let hasGpu = false;
  try {
    const r = await execa(
      "nvidia-smi",
      ["--query-gpu=name", "--format=csv,noheader"],
      { stdio: "pipe", timeout: 10_000, reject: false },
    );
    hasGpu = r.exitCode === 0 && r.stdout.trim().length > 0;
  } catch {
    return { hasGpu: false, driverCudaVersion: null };
  }
  if (!hasGpu) return { hasGpu: false, driverCudaVersion: null };

  // Verbose output exposes "CUDA Version: X.Y" in the header.
  let driverCudaVersion: string | null = null;
  try {
    const v = await execa("nvidia-smi", [], {
      stdio: "pipe",
      timeout: 10_000,
      reject: false,
    });
    const text = `${v.stdout}\n${v.stderr}`;
    const m = /CUDA Version:\s*(\d+\.\d+)/i.exec(text);
    if (m) driverCudaVersion = m[1];
  } catch {
    /* ignore — keep null */
  }

  return { hasGpu, driverCudaVersion };
};

const indexUrlForCudaVersion = (version: string | null): string => {
  if (!version) return "https://download.pytorch.org/whl/cu124";
  const [maj, min] = version.split(".").map((n) => parseInt(n, 10));
  if (Number.isNaN(maj)) return "https://download.pytorch.org/whl/cu124";
  if (maj >= 13) return "https://download.pytorch.org/whl/cu126";
  if (maj === 12) {
    if (min >= 6) return "https://download.pytorch.org/whl/cu126";
    if (min >= 4) return "https://download.pytorch.org/whl/cu124";
    if (min >= 1) return "https://download.pytorch.org/whl/cu121";
    return "https://download.pytorch.org/whl/cu121";
  }
  if (maj === 11 && min >= 8) return "https://download.pytorch.org/whl/cu118";
  return "https://download.pytorch.org/whl/cu124";
};

// --- whisperx python resolution ---------------------------------------------

/**
 * Locate the Python interpreter backing the user's WhisperX install so we
 * can run `import torch` checks and pip operations against the same env.
 *
 * Resolution order:
 *   1. explicit `whisperx.pythonPath` setting (manual override)
 *   2. project-managed venv at `<projectDir>/.venv` (created by `uv sync`
 *      against the shipped pyproject.toml — this is the default)
 *   3. legacy `uv tool dir whisperx` for users who installed via
 *      `uv tool install whisperx` before the pyproject.toml migration
 *   4. null (caller treats as "couldn't introspect")
 */
export const resolveWhisperxPython = async (): Promise<string | null> => {
  const s = (await getSettings()).whisperx;
  const explicit = s.pythonPath?.trim();
  if (explicit) return explicit;

  // Project-managed venv. We do NOT call ensureWhisperxProjectDir() here
  // because this is a probe path — we just want to know if the venv
  // exists, not create the project dir as a side effect.
  try {
    const projectPython = getWhisperxVenvPython();
    if (fs.existsSync(projectPython)) return projectPython;
  } catch {
    /* electron app not ready / packaging issue — fall through */
  }

  try {
    const r = await execa(getUvExecutable(), ["tool", "dir", "whisperx"], {
      stdio: "pipe",
      timeout: 10_000,
      reject: false,
    });
    if (r.exitCode === 0) {
      const dir = r.stdout.trim().split(/\r?\n/).pop()?.trim();
      if (dir) {
        const py =
          process.platform === "win32"
            ? path.join(dir, "Scripts", "python.exe")
            : path.join(dir, "bin", "python");
        if (fs.existsSync(py)) return py;
      }
    }
  } catch {
    /* uv not installed or whisperx not managed by uv */
  }

  return null;
};

// --- torch probe -------------------------------------------------------------

const probeTorch = async (
  python: string | null,
): Promise<{ available: boolean; version: string | null }> => {
  if (!python) return { available: false, version: null };
  try {
    const r = await execa(
      python,
      [
        "-c",
        "import torch;print(torch.cuda.is_available());print(torch.__version__)",
      ],
      { stdio: "pipe", timeout: 30_000, reject: false },
    );
    if (r.exitCode !== 0) return { available: false, version: null };
    const lines = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const available = /^true$/i.test(lines[0] ?? "");
    const version = lines[1] ?? null;
    return { available, version };
  } catch {
    return { available: false, version: null };
  }
};

// --- public: CudaTorchMissingError ------------------------------------------

/**
 * Thrown by the WhisperX pipeline preflight when the user has selected
 * `device=cuda` and the host has an NVIDIA GPU, but the WhisperX Python
 * environment has CPU-only torch installed. WhisperX would otherwise crash
 * mid-run with `cublas64_12.dll is not found` after ~10s; this error blocks
 * the run before WhisperX is invoked so the renderer can prompt the user to
 * install CUDA torch from Settings → WhisperX.
 */
export class CudaTorchMissingError extends Error {
  readonly code = "CUDA_TORCH_MISSING" as const;

  readonly suggestedIndexUrl: string | null;

  constructor(suggestedIndexUrl: string | null) {
    super(
      "CUDA torch is not installed. WhisperX cannot use your GPU. " +
        "Go to Settings → WhisperX to install CUDA support.",
    );
    this.name = "CudaTorchMissingError";
    this.suggestedIndexUrl = suggestedIndexUrl;
  }
}

// --- public: checkCudaHealth -------------------------------------------------

/**
 * In-process cache of the most recent successful health probe. The probe
 * runs nvidia-smi + a `python -c 'import torch'` subprocess (~hundreds of
 * ms) so we cache it for the lifetime of the main process to avoid
 * re-probing on every recording. The renderer's reinstall flow calls
 * `invalidateCudaHealthCache()` after a successful torch reinstall so the
 * next pipeline run picks up the new state.
 */
let cachedHealth: CudaHealthResult | null = null;
let cachedHealthInFlight: Promise<CudaHealthResult> | null = null;

export const invalidateCudaHealthCache = (): void => {
  cachedHealth = null;
};

export const checkCudaHealthCached = async (): Promise<CudaHealthResult> => {
  if (cachedHealth) return cachedHealth;
  if (cachedHealthInFlight) return cachedHealthInFlight;
  cachedHealthInFlight = (async () => {
    try {
      const result = await checkCudaHealth();
      cachedHealth = result;
      return result;
    } catch (e) {
      // Probe failures (nvidia-smi timeout, exec error on a non-NVIDIA box,
      // etc.) used to leave cachedHealth=null and cause every subsequent
      // call to re-run the 2s+ probe. Cache a known-negative result so
      // non-NVIDIA hosts don't pay that cost on every recording. The
      // renderer can force a re-probe by calling invalidateCudaHealthCache.
      log.warn(
        `[whisperx-cuda] CUDA health probe failed; caching negative result: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      const negative: CudaHealthResult = {
        hasNvidiaGpu: false,
        cudaDriverVersion: null,
        torchCudaAvailable: false,
        torchVersion: null,
        suggestedIndexUrl: null,
      };
      cachedHealth = negative;
      return negative;
    }
  })();
  try {
    return await cachedHealthInFlight;
  } finally {
    cachedHealthInFlight = null;
  }
};

export const checkCudaHealth = async (): Promise<CudaHealthResult> => {
  const { hasGpu, driverCudaVersion } = await probeNvidiaSmi();
  const python = await resolveWhisperxPython();
  const torch = await probeTorch(python);

  const suggestedIndexUrl = hasGpu
    ? indexUrlForCudaVersion(driverCudaVersion)
    : null;

  return {
    hasNvidiaGpu: hasGpu,
    cudaDriverVersion: driverCudaVersion,
    torchCudaAvailable: torch.available,
    torchVersion: torch.version,
    suggestedIndexUrl,
  };
};

// --- public: reinstallCudaTorch ---------------------------------------------

const INSTALL_TIMEOUT_MS = 3 * 60_000;

export const reinstallCudaTorch = async (
  indexUrl: string,
): Promise<{ ok: boolean; error?: string }> => {
  if (installState.inProgress) {
    return { ok: false, error: "An install is already in progress." };
  }

  // Light validation — only allow the documented PyTorch wheel index host.
  try {
    const u = new URL(indexUrl);
    if (u.hostname !== "download.pytorch.org") {
      return {
        ok: false,
        error: `Refusing index URL outside download.pytorch.org: ${indexUrl}`,
      };
    }
  } catch {
    return { ok: false, error: `Invalid index URL: ${indexUrl}` };
  }

  // The pyproject.toml drives the install — `indexUrl` is retained for
  // API compatibility but no longer routes the install. The CUDA wheel
  // index is declared in pyproject.toml's [tool.uv.sources].
  let projectDir: string;
  try {
    projectDir = await ensureWhisperxProjectDir();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `Could not prepare WhisperX project directory: ${msg}`,
    };
  }

  installState = {
    inProgress: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: null,
    error: null,
    log: "",
  };

  // Patch the [[tool.uv.index]] url in pyproject.toml to match the
  // driver-derived indexUrl before syncing, so users on cu118 / cu121 /
  // cu124 drivers don't get the cu126 wheel hardcoded in the shipped
  // pyproject. We restore the original file after sync so the on-disk
  // copy matches what was bundled (avoids confusing diffs and prevents
  // ensureWhisperxProjectDir's content-equality check from re-copying it
  // every launch).
  const pyprojectPath = path.join(projectDir, "pyproject.toml");
  let originalPyproject: string | null = null;
  try {
    originalPyproject = await fs.readFile(pyprojectPath, "utf-8");
    const patched = originalPyproject.replace(
      /(\[\[tool\.uv\.index\]\][\s\S]*?url\s*=\s*")[^"]+(")/,
      `$1${indexUrl}$2`,
    );
    if (patched === originalPyproject) {
      log.warn(
        `[whisperx-cuda] could not locate [[tool.uv.index]] url in pyproject.toml; proceeding with bundled URL`,
      );
    } else {
      await fs.writeFile(pyprojectPath, patched, "utf-8");
      appendLog(`# patched pyproject.toml index url -> ${indexUrl}\n`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(
      `[whisperx-cuda] failed to patch pyproject.toml index url (${msg}); proceeding with bundled URL`,
    );
  }

  const args = ["sync"];

  log.info(
    `[whisperx-cuda] running uv sync in ${projectDir} (target index ${indexUrl})`,
  );
  appendLog(`$ (cwd=${projectDir}) uv ${args.join(" ")}\n`);

  const restorePyproject = async () => {
    if (originalPyproject === null) return;
    try {
      await fs.writeFile(pyprojectPath, originalPyproject, "utf-8");
    } catch (e) {
      log.warn(
        `[whisperx-cuda] failed to restore pyproject.toml: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  };

  try {
    const proc = execa(getUvExecutable(), args, {
      cwd: projectDir,
      stdio: "pipe",
      timeout: INSTALL_TIMEOUT_MS,
      reject: false,
    });
    proc.stdout?.on("data", (d: Buffer) => appendLog(d.toString()));
    proc.stderr?.on("data", (d: Buffer) => appendLog(d.toString()));
    const r = await proc;

    await restorePyproject();

    if (r.exitCode === 0) {
      installState = {
        ...installState,
        inProgress: false,
        finishedAt: new Date().toISOString(),
        ok: true,
        error: null,
      };
      // Force the next pipeline run to re-probe so it sees the freshly
      // installed CUDA torch instead of the stale cached state.
      invalidateCudaHealthCache();
      return { ok: true };
    }
    // execa sets `timedOut: true` on r when the timeout fires; the
    // exit code in that case is null/non-zero with a SIGTERM signal.
    const timedOut = (r as { timedOut?: boolean }).timedOut === true;
    const errMsg = timedOut
      ? `Installation timed out after ${INSTALL_TIMEOUT_MS / 60_000} minutes. Check your network connection and try again.`
      : `uv sync exited with code ${r.exitCode}`;
    installState = {
      ...installState,
      inProgress: false,
      finishedAt: new Date().toISOString(),
      ok: false,
      error: errMsg,
    };
    return { ok: false, error: errMsg };
  } catch (e) {
    await restorePyproject();
    const msg = e instanceof Error ? e.message : String(e);
    installState = {
      ...installState,
      inProgress: false,
      finishedAt: new Date().toISOString(),
      ok: false,
      error: msg,
    };
    return { ok: false, error: msg };
  }
};
