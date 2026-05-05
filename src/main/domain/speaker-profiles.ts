import path from "path";
import fs from "fs-extra";
import { randomUUID } from "crypto";
import { app } from "electron";
import log from "electron-log/main";
import { execa } from "execa";
import * as settings from "./settings";
import { getUvExecutable } from "../../main-utils";
import { SpeakerProfile, RecordingMeta } from "../../types";
import { invalidateUiKeys } from "../ipc/invalidate-ui";
import { QueryKeys } from "../../query-keys";
import * as history from "./history";

const profilesFile = () =>
  path.join(app.getPath("userData"), "speaker-profiles.json");

type ProfilesShape = {
  profiles: SpeakerProfile[];
  lastError: {
    stage: string;
    message: string;
    at: string;
  } | null;
  lastDryRun?: {
    ok: boolean;
    message: string;
    dim?: number;
    at: string;
  } | null;
};

const empty = (): ProfilesShape => ({
  profiles: [],
  lastError: null,
  lastDryRun: null,
});

const read = async (): Promise<ProfilesShape> => {
  try {
    if (!fs.existsSync(profilesFile())) return empty();
    const raw = (await fs.readJSON(profilesFile())) as Partial<ProfilesShape>;
    return {
      profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
      lastError: raw.lastError ?? null,
      lastDryRun: raw.lastDryRun ?? null,
    };
  } catch (e) {
    log.error("speaker-profiles: failed to read store", e);
    return empty();
  }
};

const write = async (data: ProfilesShape) => {
  await fs.writeJSON(profilesFile(), data, { spaces: 2 });
  await invalidateUiKeys(QueryKeys.SpeakerProfiles);
};

export const listProfiles = async (): Promise<SpeakerProfile[]> => {
  return (await read()).profiles;
};

export const getLastError = async () => {
  const s = await read();
  return { lastError: s.lastError, lastDryRun: s.lastDryRun ?? null };
};

export const setLastError = async (
  err: { stage: string; message: string } | null,
) => {
  const s = await read();
  s.lastError = err ? { ...err, at: new Date().toISOString() } : null;
  await write(s);
};

/**
 * Compute a running-mean embedding update and L2-normalize the result.
 * Used when confirming a speaker match to refine the profile vector over time.
 */
export const updateProfileEmbedding = (
  profile: SpeakerProfile,
  newEmbedding: number[],
): SpeakerProfile => {
  const count = profile.sampleCount ?? 1;
  const updated = profile.embedding.map(
    (v, i) => (v * count + (newEmbedding[i] ?? 0)) / (count + 1),
  );
  // L2 normalize so cosine-similarity comparisons remain well-conditioned.
  const norm = Math.sqrt(updated.reduce((s, v) => s + v * v, 0));
  const normalized = norm > 0 ? updated.map((v) => v / norm) : updated;
  return {
    ...profile,
    embedding: normalized,
    sampleCount: count + 1,
    updatedAt: new Date().toISOString(),
  };
};

export const upsertProfile = async (
  profile: Omit<SpeakerProfile, "id" | "createdAt" | "updatedAt"> &
    Partial<Pick<SpeakerProfile, "id">> & { useRunningMean?: boolean },
): Promise<SpeakerProfile> => {
  const s = await read();
  const now = new Date().toISOString();
  const existing = profile.id
    ? s.profiles.find((p) => p.id === profile.id)
    : undefined;
  if (existing) {
    existing.name = profile.name;
    // When called from a confirmation flow, use running-mean to refine the
    // embedding. When called from a manual "save as profile" flow, overwrite
    // directly (the caller passes useRunningMean: false or leaves it unset).
    if (profile.useRunningMean) {
      const updated = updateProfileEmbedding(existing, profile.embedding);
      existing.embedding = updated.embedding;
      existing.sampleCount = updated.sampleCount;
    } else {
      existing.embedding = profile.embedding;
      existing.sampleCount = profile.sampleCount ?? existing.sampleCount ?? 1;
    }
    existing.updatedAt = now;
    await write(s);
    return existing;
  }
  const created: SpeakerProfile = {
    id: profile.id ?? randomUUID(),
    name: profile.name,
    embedding: profile.embedding,
    sampleCount: profile.sampleCount ?? 1,
    createdAt: now,
    updatedAt: now,
  };
  s.profiles.push(created);
  await write(s);
  return created;
};

export const renameProfile = async (id: string, name: string) => {
  const s = await read();
  const p = s.profiles.find((x) => x.id === id);
  if (!p) throw new Error(`profile ${id} not found`);
  p.name = name;
  p.updatedAt = new Date().toISOString();
  await write(s);
  return p;
};

export const removeProfile = async (id: string) => {
  const s = await read();
  s.profiles = s.profiles.filter((p) => p.id !== id);
  await write(s);
};

// --- managed venv + dependency installer ----------------------------------

/**
 * The sidecar runs inside its own isolated Python virtual environment under
 * the app's userData directory. This avoids conflicts with WhisperX's uv
 * tool environment and any user-level site-packages that might already have
 * incompatible versions of torch/numpy/decorator/etc. installed.
 *
 * All installs target this venv explicitly via `uv pip install --python`,
 * and the sidecar is invoked with the venv's Python binary — never a bare
 * `python`/`python3` off PATH.
 */
const venvDir = (): string => path.join(app.getPath("userData"), "embed-venv");

const venvPythonPath = (dir: string = venvDir()): string =>
  process.platform === "win32"
    ? path.join(dir, "Scripts", "python.exe")
    : path.join(dir, "bin", "python");

export type VenvStatus = {
  path: string;
  python: string;
  exists: boolean;
  healthy: boolean;
  pythonVersion: string | null;
  error: string | null;
};

export const getVenvStatus = async (): Promise<VenvStatus> => {
  const dir = venvDir();
  const py = venvPythonPath(dir);
  const exists = fs.existsSync(py);
  if (!exists) {
    return {
      path: dir,
      python: py,
      exists: false,
      healthy: false,
      pythonVersion: null,
      error: null,
    };
  }
  try {
    const result = await execa(py, ["--version"], {
      stdio: "pipe",
      timeout: 10_000,
      reject: false,
    });
    const version = `${result.stdout || ""} ${result.stderr || ""}`.trim();
    return {
      path: dir,
      python: py,
      exists: true,
      healthy: result.exitCode === 0,
      pythonVersion: version || null,
      error:
        result.exitCode === 0
          ? null
          : `python --version exited ${result.exitCode}`,
    };
  } catch (e) {
    return {
      path: dir,
      python: py,
      exists: true,
      healthy: false,
      pythonVersion: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
};

/**
 * Detect whether an NVIDIA CUDA-capable GPU toolchain is available on this
 * machine. We check for `nvidia-smi` on PATH (runtime driver) and the
 * CUDA_PATH env var (toolkit installation). Either signal is sufficient to
 * pick the CUDA torch wheel; otherwise we fall back to the CPU build.
 *
 * When the driver is present we also parse its reported CUDA runtime
 * version so we can pick a matching PyTorch wheel index instead of
 * hardcoding `cu128` — mismatched CUDA/PyTorch pairs either fail to load
 * or crash on first kernel launch.
 */
type CudaInfo = {
  present: boolean;
  major: number | null;
  minor: number | null;
};

const detectCudaInfo = async (): Promise<CudaInfo> => {
  const none: CudaInfo = { present: false, major: null, minor: null };
  let present = false;
  let versionText = "";
  try {
    const r = await execa("nvidia-smi", [], {
      stdio: "pipe",
      timeout: 5_000,
      reject: false,
    });
    if (r.exitCode === 0) {
      present = true;
      versionText = `${r.stdout || ""}\n${r.stderr || ""}`;
    }
  } catch {
    /* nvidia-smi missing */
  }
  if (!present && process.env.CUDA_PATH && process.env.CUDA_PATH.trim()) {
    present = true;
  }
  if (!present) return none;

  // nvidia-smi prints e.g. "CUDA Version: 12.4" in its header.
  const m = /CUDA\s+Version\s*:\s*(\d+)\.(\d+)/i.exec(versionText);
  if (m) {
    return { present: true, major: Number(m[1]), minor: Number(m[2]) };
  }
  return { present: true, major: null, minor: null };
};

/**
 * Map the detected CUDA runtime version to the closest PyTorch wheel
 * channel. PyTorch publishes a small set of indexes (cu121, cu124, cu128
 * at time of writing); we clamp to the highest channel <= driver version.
 * If we can't parse a version we pick cu121 as the conservative floor,
 * which works on virtually all drivers that ship CUDA 12.x.
 */
const pickCudaChannel = (info: CudaInfo): string => {
  if (info.major == null) return "cu121";
  const key = info.major * 100 + (info.minor ?? 0);
  if (key >= 1208) return "cu128";
  if (key >= 1204) return "cu124";
  if (key >= 1201) return "cu121";
  return "cu121";
};

const torchIndexArgs = (cuda: boolean, info?: CudaInfo): string[] => {
  if (!cuda) return [];
  const channel = pickCudaChannel(
    info ?? { present: true, major: null, minor: null },
  );
  return ["--index-url", `https://download.pytorch.org/whl/${channel}`];
};

/**
 * Create the managed venv if it doesn't already exist. We require `uv` on
 * PATH — this is a hard prerequisite since the rest of the install flow
 * uses `uv pip install --python <venv-python>` to target the venv.
 *
 * A module-level mutex guards against concurrent `uv venv` invocations
 * racing against the same directory, which is undefined behavior.
 */
let ensureVenvInFlight: Promise<{
  ok: boolean;
  python: string;
  uv: boolean;
  message?: string;
}> | null = null;

/**
 * Attempt to locate a usable Python interpreter for bootstrapping a venv
 * when `uv` is unavailable. On Windows the launcher (`py -3`) is the
 * canonical path and is often present when `python` isn't on PATH.
 */
const probeHostPython = async (): Promise<string | null> => {
  const isWindows = process.platform === "win32";
  type Candidate = { cmd: string; args: string[] };
  const candidates: Candidate[] = isWindows
    ? [
        { cmd: "py", args: ["-3.12"] },
        { cmd: "py", args: ["-3"] },
        { cmd: "py", args: [] },
        { cmd: "python", args: [] },
        { cmd: "python3", args: [] },
      ]
    : [
        { cmd: "python3.12", args: [] },
        { cmd: "python3", args: [] },
        { cmd: "python", args: [] },
      ];
  for (const { cmd, args } of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await execa(cmd, [...args, "--version"], {
        stdio: "pipe",
        timeout: 10_000,
        reject: false,
      });
      if (r.exitCode === 0) {
        // Join cmd + args into a single invocation string. Callers spawn
        // this via `execa(combined, [...])` by splitting on spaces; since
        // neither `py` nor `python` contain spaces this is safe.
        return [cmd, ...args].join(" ");
      }
    } catch {
      /* next */
    }
  }
  return null;
};

/**
 * Check whether `uv` is available on PATH. Cached per call.
 */
export const checkUvAvailable = async (): Promise<{
  ok: boolean;
  version: string | null;
  error?: string;
}> => {
  try {
    const r = await execa(getUvExecutable(), ["--version"], {
      stdio: "pipe",
      timeout: 5_000,
      reject: false,
    });
    if (r.exitCode === 0) {
      const v = /uv\s+([\d.]+)/i.exec(r.stdout + r.stderr)?.[1] ?? null;
      return { ok: true, version: v };
    }
    return {
      ok: false,
      version: null,
      error: `uv --version exited ${r.exitCode}`,
    };
  } catch (e) {
    return {
      ok: false,
      version: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
};

const ensureVenv = async (): Promise<{
  ok: boolean;
  python: string;
  uv: boolean;
  message?: string;
}> => {
  if (ensureVenvInFlight) return ensureVenvInFlight;
  ensureVenvInFlight = (async () => {
    const dir = venvDir();
    const py = venvPythonPath(dir);
    if (fs.existsSync(py)) {
      // Detect whether uv is still available so downstream pip installs
      // can pick the right strategy.
      const uv = await checkUvAvailable();
      return { ok: true, python: py, uv: uv.ok };
    }
    await fs.ensureDir(path.dirname(dir));
    log.info(`[speaker-profiles] creating venv at ${dir}`);

    // Strategy 1: uv (fast + manages Python toolchain installs).
    const uvProbe = await checkUvAvailable();
    if (uvProbe.ok) {
      try {
        const result = await execa(
          getUvExecutable(),
          ["venv", dir, "--python", "3.12"],
          {
            stdio: "pipe",
            timeout: 2 * 60_000,
            reject: false,
          },
        );
        if (result.exitCode === 0 && fs.existsSync(py)) {
          return { ok: true, python: py, uv: true };
        }
        log.warn(
          `[speaker-profiles] uv venv exited ${result.exitCode}, falling back to python -m venv: ${result.stderr || result.stdout}`,
        );
      } catch (e) {
        log.warn(
          "[speaker-profiles] uv venv failed to launch, falling back:",
          e,
        );
      }
    }

    // Strategy 2: python -m venv with a host-discovered interpreter.
    const host = await probeHostPython();
    if (!host) {
      return {
        ok: false,
        python: py,
        uv: uvProbe.ok,
        message:
          "Could not find `uv` or a usable host Python. Install `uv` (https://docs.astral.sh/uv/getting-started/installation/) or Python 3.10+ and try again.",
      };
    }
    const [hostCmd, ...hostArgs] = host.split(" ");
    try {
      const result = await execa(hostCmd, [...hostArgs, "-m", "venv", dir], {
        stdio: "pipe",
        timeout: 2 * 60_000,
        reject: false,
      });
      if (result.exitCode !== 0) {
        return {
          ok: false,
          python: py,
          uv: uvProbe.ok,
          message: `\`${host} -m venv\` failed: ${result.stderr || result.stdout}`,
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        python: py,
        uv: uvProbe.ok,
        message: `\`${host} -m venv\` failed to launch: ${msg}`,
      };
    }
    if (!fs.existsSync(py)) {
      return {
        ok: false,
        python: py,
        uv: uvProbe.ok,
        message: `venv created but python not found at ${py}`,
      };
    }
    return { ok: true, python: py, uv: uvProbe.ok };
  })();
  try {
    return await ensureVenvInFlight;
  } finally {
    ensureVenvInFlight = null;
  }
};

/** Remove the managed venv directory entirely. Uses sync removal to guarantee
 * the directory is gone before any subsequent `uv venv` call proceeds.
 *
 * Windows-specific: `fs.rmSync` intermittently fails when antivirus is
 * scanning the venv contents. We retry up to 3 times with a short backoff
 * before giving up, so the user doesn't hit a phantom failure during
 * rebuild.
 */
export const destroyVenv = async (): Promise<void> => {
  const dir = venvDir();
  log.info(`[speaker-profiles] removing venv at ${dir}`);
  const attempts = 3;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === attempts - 1) {
        log.warn("[speaker-profiles] venv removal failed after retries", e);
        return;
      }
      log.info(
        `[speaker-profiles] venv removal attempt ${i + 1} failed, retrying…`,
        e,
      );
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
    }
  }
};

/**
 * Install all embedding dependencies into the managed venv. This wipes any
 * prior state via `--reinstall` on the torch step so CUDA/CPU switches and
 * partial installs don't leave a half-broken environment.
 *
 * Platform notes:
 * - Windows: resemblyzer's transitive `webrtcvad` has no prebuilt wheels for
 *   most Python versions and requires MSVC to compile. We install
 *   resemblyzer with --no-deps and substitute `webrtcvad-wheels`, a
 *   prebuilt-wheel fork that provides the same module.
 * - Linux/macOS: webrtcvad ships prebuilt wheels on common Python versions,
 *   so a normal install works. We still pin `webrtcvad-wheels` explicitly
 *   to keep the dep set identical across platforms.
 */
const uvPipInstall = async (
  python: string,
  args: string[],
  timeoutMs = 15 * 60_000,
  useUv = true,
) => {
  if (useUv) {
    const full = ["pip", "install", "--python", python, ...args];
    log.info(`[speaker-profiles] uv ${full.join(" ")}`);
    return execa(getUvExecutable(), full, {
      stdio: "pipe",
      timeout: timeoutMs,
      reject: false,
    });
  }
  // Fallback path: invoke the venv's own pip directly. This matters when
  // `uv` is unavailable on the host (rare but happens on locked-down
  // corporate machines).
  const full = ["-m", "pip", "install", ...args];
  log.info(`[speaker-profiles] ${python} ${full.join(" ")}`);
  return execa(python, full, {
    stdio: "pipe",
    timeout: timeoutMs,
    reject: false,
  });
};

export const installEmbedDeps = async (): Promise<{
  ok: boolean;
  message: string;
}> => {
  log.info("[speaker-profiles] installing embedding deps (venv mode)");

  const isWindows = process.platform === "win32";
  const cudaInfo = await detectCudaInfo();
  const cuda = cudaInfo.present;
  log.info(
    `[speaker-profiles] GPU detection: ${
      cuda
        ? `CUDA (nvidia${
            cudaInfo.major != null
              ? ` ${cudaInfo.major}.${cudaInfo.minor ?? 0}`
              : ""
          })`
        : "CPU"
    }`,
  );

  const venv = await ensureVenv();
  if (!venv.ok) {
    return { ok: false, message: venv.message ?? "venv setup failed" };
  }
  const py = venv.python;
  const useUv = venv.uv;
  log.info(
    `[speaker-profiles] installer strategy: ${useUv ? "uv pip" : "venv pip"}`,
  );

  // Step 1: torch + torchaudio with the correct wheel index. If the CUDA
  // install fails (mismatched driver, 404'd wheel, etc.) fall back to the
  // CPU build so the user at least gets a working environment.
  const torchArgs = torchIndexArgs(cuda, cudaInfo);
  let torch = await uvPipInstall(
    py,
    ["torch", "torchaudio", ...torchArgs],
    15 * 60_000,
    useUv,
  );
  let usedCpuFallback = false;
  if (torch.exitCode !== 0 && cuda) {
    log.warn(
      "[speaker-profiles] CUDA torch install failed, falling back to CPU build:",
      torch.stderr || torch.stdout,
    );
    torch = await uvPipInstall(
      py,
      ["--reinstall", "torch", "torchaudio"],
      15 * 60_000,
      useUv,
    );
    usedCpuFallback = true;
  }
  if (torch.exitCode !== 0) {
    return {
      ok: false,
      message: `torch install failed: ${torch.stderr || torch.stdout}`,
    };
  }

  // Step 2: core scientific deps. `soundfile` lets the sidecar do
  // random-access per-segment reads instead of decoding the entire file
  // into RAM via librosa.
  const core = await uvPipInstall(
    py,
    ["numpy", "librosa", "soundfile", "decorator"],
    10 * 60_000,
    useUv,
  );
  if (core.exitCode !== 0) {
    return {
      ok: false,
      message: `core dep install failed: ${core.stderr || core.stdout}`,
    };
  }

  // Step 3: resemblyzer without transitive deps, plus our pinned substitutes.
  const resem = await uvPipInstall(
    py,
    ["--no-deps", "resemblyzer"],
    5 * 60_000,
    useUv,
  );
  if (resem.exitCode !== 0) {
    return {
      ok: false,
      message: `resemblyzer install failed: ${resem.stderr || resem.stdout}`,
    };
  }

  // webrtcvad-wheels provides the `webrtcvad` module with prebuilt wheels on
  // every supported platform, avoiding the Windows MSVC requirement.
  const vad = await uvPipInstall(py, ["webrtcvad-wheels"], 5 * 60_000, useUv);
  if (vad.exitCode !== 0) {
    return {
      ok: false,
      message: `webrtcvad-wheels install failed: ${vad.stderr || vad.stdout}`,
    };
  }

  // umap-learn is used internally by resemblyzer; install non-fatally.
  const umap = await uvPipInstall(py, ["umap-learn"], 5 * 60_000, useUv);
  if (umap.exitCode !== 0) {
    log.warn(
      "[speaker-profiles] umap-learn install failed (non-fatal):",
      umap.stderr,
    );
  }

  const torchLabel = usedCpuFallback
    ? "CPU (CUDA fallback)"
    : cuda
      ? `CUDA ${pickCudaChannel(cudaInfo)
          .replace("cu", "")
          .replace(/(\d)(\d)$/, "$1.$2")}`
      : "CPU";
  const note = `torch: ${torchLabel}${isWindows ? "; webrtcvad-wheels" : ""}`;
  return {
    ok: true,
    message: `Installed into managed venv (${note})`,
  };
};

/**
 * Wipe and recreate the venv from scratch, reinstalling every dep. Used by
 * the Settings UI "Rebuild environment" button and as the automatic repair
 * path when the sidecar fails with an import error.
 */
export const rebuildEmbedVenv = async (): Promise<{
  ok: boolean;
  message: string;
}> => {
  await destroyVenv();
  return installEmbedDeps();
};

const isMissingModuleError = (message: string): boolean =>
  message.includes("No module named") ||
  message.includes("ModuleNotFoundError");

// --- sidecar ---------------------------------------------------------------

const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa === 0 || bb === 0) return 0;
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
};

const resolveScriptPath = async (): Promise<string> => {
  const override = (await settings.getSettings()).whisperx.embeddings
    ?.scriptPath;
  if (override && override.trim()) return override.trim();

  // Candidates: packaged resources, source tree, cwd.
  const candidates: string[] = [];
  // When running under Electron Forge / packaged app, scripts/ is copied to
  // resourcesPath/scripts via the forge extraResource entry. During dev it
  // sits next to the project root.
  try {
    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, "scripts", "embed_speakers.py"),
      );
      candidates.push(path.join(process.resourcesPath, "embed_speakers.py"));
    }
  } catch {
    /* ignore */
  }
  try {
    const here = typeof __dirname === "string" ? __dirname : process.cwd();
    candidates.push(
      path.resolve(here, "..", "..", "..", "scripts", "embed_speakers.py"),
    );
    candidates.push(
      path.resolve(
        here,
        "..",
        "..",
        "..",
        "..",
        "scripts",
        "embed_speakers.py",
      ),
    );
  } catch {
    /* ignore */
  }
  candidates.push(path.resolve(process.cwd(), "scripts", "embed_speakers.py"));

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `embed_speakers.py not found. Tried:\n${candidates.map((c) => `  - ${c}`).join("\n")}`,
  );
};

/**
 * Resolve the Python binary to run the sidecar with.
 *
 * Priority:
 *   1. explicit whisperx.embeddings.pythonPath setting (power-user override)
 *   2. the managed venv at <userData>/embed-venv — ensured to exist
 *   3. fallback to system python (legacy path, will fail fast with a clear
 *      install message if the venv can't be created)
 */
const resolvePythonCmd = async (): Promise<string> => {
  const s = (await settings.getSettings()).whisperx;
  const explicit = s.embeddings?.pythonPath?.trim();
  if (explicit) return explicit;
  const py = venvPythonPath();
  if (fs.existsSync(py)) return py;
  // Venv is missing — try to create it on the fly. If this fails the caller
  // will see a clear error and can hit "Rebuild environment" in settings.
  const venv = await ensureVenv();
  if (venv.ok) return venv.python;
  if (s.pythonPath && s.pythonPath.trim()) return s.pythonPath.trim();
  // Last-ditch fallback when the venv can't be created and no explicit
  // interpreter is configured. On Windows, the launcher `py` is the
  // canonical path and is often present when `python` isn't on PATH.
  if (process.platform === "win32") {
    for (const candidate of ["py", "python", "python3"]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await execa(candidate, ["--version"], {
          stdio: "pipe",
          timeout: 5_000,
          reject: false,
        });
        if (r.exitCode === 0) return candidate;
      } catch {
        /* next */
      }
    }
    return "python";
  }
  return "python3";
};

export type SidecarResult = {
  ok: true;
  embeddings: Record<string, number[]>;
  durations: Record<string, number>;
  method: string;
  dim: number;
};

const runSidecar = async (
  args: string[],
  opts: { stage: string; timeoutMs?: number; autoInstall?: boolean },
): Promise<any> => {
  const python = await resolvePythonCmd();
  const script = await resolveScriptPath();
  const fullArgs = [script, ...args];
  log.info(`[speaker-profiles:${opts.stage}] running`, python, fullArgs);

  // Make sure the sidecar can find our bundled ffmpeg for any audio-read
  // paths that fall through to audioread/ffmpeg (e.g. mp3 decoding on
  // Windows). We don't rely on this for wav — soundfile handles that
  // natively — but extending PATH is cheap defense-in-depth.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  try {
    // Lazy import to avoid circular deps at module load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ffmpeg = require("./ffmpeg") as typeof import("./ffmpeg");
    const status = ffmpeg.getCachedFfmpegStatus();
    if (status?.ok && status.path) {
      const ffDir = path.dirname(status.path);
      const sep = process.platform === "win32" ? ";" : ":";
      childEnv.PATH = childEnv.PATH ? `${ffDir}${sep}${childEnv.PATH}` : ffDir;
    }
  } catch {
    /* best-effort */
  }

  let result;
  try {
    result = await execa(python, fullArgs, {
      stdio: "pipe",
      timeout: opts.timeoutMs ?? 5 * 60_000,
      reject: false,
      env: childEnv,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setLastError({ stage: opts.stage, message: msg });
    throw new Error(
      `sidecar launch failed (${opts.stage}): ${msg}. Is Python installed and on PATH?`,
    );
  }

  // Forward sidecar stderr to electron-log so we can diagnose later.
  const stderr = (result.stderr || "").toString();
  if (stderr.trim()) {
    stderr
      .split("\n")
      .filter(Boolean)
      .forEach((line) => log.info(`[speaker-profiles:${opts.stage}] ${line}`));
  }

  const stdout = (result.stdout || "").toString().trim();
  // The script writes exactly one JSON line to stdout on success, or an
  // {"ok":false,"error":...} line on failure. Tolerate extra blank lines.
  const jsonLine =
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() || "";

  let parsed: any = null;
  if (jsonLine) {
    try {
      parsed = JSON.parse(jsonLine);
    } catch {
      parsed = null;
    }
  }

  if (result.exitCode !== 0 || (parsed && parsed.ok === false)) {
    const errMsg =
      (parsed && parsed.error) ||
      stderr.trim().split("\n").slice(-5).join(" | ") ||
      `sidecar exited with code ${result.exitCode}`;

    // Auto-repair missing Python deps on first failure, then retry once.
    // A missing module inside the managed venv almost always means the venv
    // is in a broken/partial state (e.g. cancelled prior install, mid-
    // upgrade corruption). Wipe and rebuild from scratch rather than
    // layering more installs onto a bad environment.
    if (opts.autoInstall !== false && isMissingModuleError(errMsg)) {
      log.info(
        "[speaker-profiles] missing module in venv — rebuilding from scratch",
      );
      await setLastError({
        stage: opts.stage,
        message: "Rebuilding embedding environment… please wait",
      });
      const install = await rebuildEmbedVenv();
      if (install.ok) {
        log.info("[speaker-profiles] venv rebuilt, retrying sidecar");
        return runSidecar(args, { ...opts, autoInstall: false });
      }
      // Install failed — surface the *install* error, not the stale
      // "module missing" one. Otherwise users chase a phantom import
      // problem when the real issue is a venv/network/disk failure.
      const combinedMsg = `Embedding environment rebuild failed: ${install.message}\n(original sidecar error: ${errMsg})`;
      log.error(`[speaker-profiles:${opts.stage}] ${combinedMsg}`);
      await setLastError({ stage: opts.stage, message: combinedMsg });
      throw new Error(combinedMsg);
    }

    await setLastError({ stage: opts.stage, message: errMsg });
    throw new Error(errMsg);
  }

  return parsed;
};

export const extractEmbeddings = async (params: {
  audioPath: string;
  segments: Array<{ speaker: string; start: number; end: number }>;
}): Promise<SidecarResult> => {
  const tmpSeg = path.join(
    app.getPath("userData"),
    "logs",
    `embed-segments-${Date.now()}.json`,
  );
  await fs.ensureDir(path.dirname(tmpSeg));
  await fs.writeJSON(tmpSeg, { segments: params.segments });
  try {
    const result = (await runSidecar(
      ["--audio", params.audioPath, "--segments", tmpSeg],
      { stage: "embed", timeoutMs: 15 * 60_000 },
    )) as SidecarResult;
    await setLastError(null);
    return result;
  } finally {
    await fs.remove(tmpSeg).catch(() => {});
  }
};

export const testPipeline = async (): Promise<{
  ok: boolean;
  message: string;
  dim?: number;
}> => {
  try {
    const parsed = await runSidecar(["--dry-run"], {
      stage: "dry-run",
      timeoutMs: 120_000,
    });
    const s = await read();
    s.lastError = null;
    s.lastDryRun = {
      ok: true,
      message: `embedding dim=${parsed.dim} via ${parsed.method}`,
      dim: parsed.dim,
      at: new Date().toISOString(),
    };
    await write(s);
    return { ok: true, message: s.lastDryRun.message, dim: parsed.dim };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const s = await read();
    s.lastDryRun = {
      ok: false,
      message,
      at: new Date().toISOString(),
    };
    await write(s);
    return { ok: false, message };
  }
};

export type SpeakerMatch = {
  profileId: string | null;
  profileName: string | null;
  confidence: number;
  matched: boolean;
};

export const matchSpeaker = async (
  embedding: number[],
  threshold: number,
): Promise<SpeakerMatch> => {
  const profiles = await listProfiles();
  if (profiles.length === 0) {
    return {
      profileId: null,
      profileName: null,
      confidence: 0,
      matched: false,
    };
  }
  let best: SpeakerProfile | null = null;
  let bestSim = -Infinity;
  for (const p of profiles) {
    const sim = cosineSimilarity(embedding, p.embedding);
    if (sim > bestSim) {
      bestSim = sim;
      best = p;
    }
  }
  const confidence = Math.max(0, bestSim);
  return {
    profileId: best?.id ?? null,
    profileName: best?.name ?? null,
    confidence,
    matched: confidence >= threshold,
  };
};

/**
 * Confirm a speaker suggestion: mark the match as confirmed, apply a
 * running-mean embedding update on the matched profile, and persist both
 * the recording meta and the updated profile. Does NOT write speakerNames —
 * the display name is now resolved live from the profile at render time.
 *
 * Returns the updated speakerMatches record so the caller can push it into
 * the renderer via updateMeta.
 */
export const confirmSpeakerMatch = async (
  recordingId: string,
  speakerKey: string,
  profileId: string,
): Promise<RecordingMeta["speakerMatches"]> => {
  const meta = await history.getRecordingMeta(recordingId);
  const embedding = meta.speakerEmbeddings?.[speakerKey];

  const s = await read();
  const profile = s.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`profile ${profileId} not found`);

  // Running-mean embedding update — only when we have an embedding for this
  // speaker on this recording.
  if (embedding) {
    const updated = updateProfileEmbedding(profile, embedding);
    profile.embedding = updated.embedding;
    profile.sampleCount = updated.sampleCount;
    profile.updatedAt = updated.updatedAt;
    await write(s);
    await invalidateUiKeys(QueryKeys.SpeakerProfiles);
  }

  const nextMatches: NonNullable<RecordingMeta["speakerMatches"]> = {
    ...(meta.speakerMatches ?? {}),
    [speakerKey]: {
      profileId: profile.id,
      profileName: profile.name,
      confidence: meta.speakerMatches?.[speakerKey]?.confidence ?? 1,
      matched: true,
    },
  };

  await history.updateRecording(recordingId, { speakerMatches: nextMatches });
  return nextMatches;
};

/**
 * Reject a speaker suggestion: record the rejection on the recording so the
 * suggestion pill is not shown again. Does not modify the profile store.
 *
 * Returns the updated speakerMatches record.
 */
export const rejectSpeakerSuggestion = async (
  recordingId: string,
  speakerKey: string,
  profileId: string,
): Promise<RecordingMeta["speakerMatches"]> => {
  const meta = await history.getRecordingMeta(recordingId);

  const prevRejected = meta.rejectedSuggestions ?? {};
  const keyRejected = prevRejected[speakerKey] ?? [];
  const nextRejected = {
    ...prevRejected,
    [speakerKey]: [...new Set([...keyRejected, profileId])],
  };

  // Also clear the match entry so it doesn't linger as a stale suggestion.
  const nextMatches: NonNullable<RecordingMeta["speakerMatches"]> = {
    ...(meta.speakerMatches ?? {}),
    [speakerKey]: {
      profileId: null,
      profileName: null,
      confidence: meta.speakerMatches?.[speakerKey]?.confidence ?? 0,
      matched: false,
    },
  };

  await history.updateRecording(recordingId, {
    speakerMatches: nextMatches,
    rejectedSuggestions: nextRejected,
  });
  return nextMatches;
};

// ---------------------------------------------------------------------------
// Profile merge
// ---------------------------------------------------------------------------

/**
 * Merge two or more speaker profiles into one canonical profile.
 *
 * - The canonical profile's embedding is recomputed as the weighted mean
 *   (by `sampleCount`) of all participating profiles, then L2-normalised.
 * - `aliases` arrays are unioned and de-duplicated.
 * - `sampleCount` is summed across all profiles.
 * - Every recording that referenced an absorbed profile via
 *   `speakerMatches[*].profileId` is updated to point to the canonical id.
 * - Absorbed profiles are deleted from the store.
 *
 * Returns the updated canonical profile.
 */
export const mergeSpeakerProfiles = async (
  canonicalId: string,
  absorbedIds: string[],
): Promise<SpeakerProfile> => {
  if (absorbedIds.length === 0) throw new Error("absorbedIds must not be empty");

  const s = await read();

  const canonical = s.profiles.find((p) => p.id === canonicalId);
  if (!canonical) throw new Error(`canonical profile ${canonicalId} not found`);

  const absorbed = absorbedIds.map((id) => {
    const p = s.profiles.find((x) => x.id === id);
    if (!p) throw new Error(`absorbed profile ${id} not found`);
    return p;
  });

  // Weighted-mean embedding accumulation.
  const allProfiles = [canonical, ...absorbed];
  let totalCount = 0;
  const dim = canonical.embedding.length;
  const accum = new Array<number>(dim).fill(0);

  for (const p of allProfiles) {
    const w = p.sampleCount ?? 1;
    totalCount += w;
    for (let i = 0; i < dim; i++) {
      accum[i] += (p.embedding[i] ?? 0) * w;
    }
  }

  // Divide by total weight then L2-normalise.
  const raw = accum.map((v) => v / totalCount);
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  const mergedEmbedding = norm > 0 ? raw.map((v) => v / norm) : raw;

  // Union aliases.
  const allAliases = new Set<string>(canonical.aliases ?? []);
  for (const p of absorbed) {
    for (const a of p.aliases ?? []) allAliases.add(a);
    // Also add the absorbed profile's name as an alias for discoverability.
    allAliases.add(p.name);
  }

  // Apply to canonical.
  canonical.embedding = mergedEmbedding;
  canonical.sampleCount = totalCount;
  canonical.aliases = [...allAliases];
  canonical.updatedAt = new Date().toISOString();

  // Remove absorbed profiles.
  const absorbedSet = new Set(absorbedIds);
  s.profiles = s.profiles.filter((p) => !absorbedSet.has(p.id));

  await write(s);

  // Rewrite recording metas: any speakerMatches entry pointing to an absorbed
  // profile gets redirected to the canonical id.
  const allRecordings = await history.listRecordings();

  const patchJobs: Promise<void>[] = [];
  for (const [recordingId, meta] of Object.entries(allRecordings)) {
    if (!meta.speakerMatches) continue;

    let changed = false;
    const nextMatches: NonNullable<RecordingMeta["speakerMatches"]> = {};
    for (const [key, match] of Object.entries(meta.speakerMatches)) {
      if (match.profileId && absorbedSet.has(match.profileId)) {
        nextMatches[key] = {
          ...match,
          profileId: canonicalId,
          profileName: canonical.name,
        };
        changed = true;
      } else {
        nextMatches[key] = match;
      }
    }

    if (changed) {
      patchJobs.push(history.updateRecording(recordingId, { speakerMatches: nextMatches }));
    }
  }

  await Promise.all(patchJobs);

  log.info(
    `[speaker-profiles] merged ${absorbedIds.join(", ")} → ${canonicalId} (${patchJobs.length} recordings updated)`,
  );

  return canonical;
};

// ---------------------------------------------------------------------------
// Avatar management
// ---------------------------------------------------------------------------

const avatarsDir = (): string =>
  path.join(app.getPath("userData"), "speaker-avatars");

/**
 * Store an avatar image for a speaker profile from a data URL.
 * Writes the image file to `<userData>/speaker-avatars/<profileId>.<ext>`,
 * updates `profile.avatar` to the basename, and persists the store.
 *
 * Returns the updated profile.
 */
export const setSpeakerAvatar = async (
  profileId: string,
  imageDataUrl: string,
): Promise<SpeakerProfile> => {
  // Parse data URL: `data:<mime>;base64,<data>`
  const match = /^data:image\/(\w+);base64,(.+)$/.exec(imageDataUrl);
  if (!match) throw new Error("imageDataUrl must be a base64 image data URL");
  const [, ext, b64] = match;
  const buffer = Buffer.from(b64, "base64");

  const s = await read();
  const profile = s.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`profile ${profileId} not found`);

  await fs.ensureDir(avatarsDir());

  // Remove old avatar file if different extension.
  if (profile.avatar) {
    const oldPath = path.join(avatarsDir(), profile.avatar);
    await fs.remove(oldPath).catch(() => {});
  }

  const basename = `${profileId}.${ext}`;
  const destPath = path.join(avatarsDir(), basename);
  await fs.writeFile(destPath, buffer);

  profile.avatar = basename;
  profile.updatedAt = new Date().toISOString();
  await write(s);

  return profile;
};

/**
 * Return the full filesystem path to the avatar file for `profileId`, or
 * `null` if no avatar is set or the file does not exist on disk.
 */
export const getSpeakerAvatarPath = async (
  profileId: string,
): Promise<string | null> => {
  const s = await read();
  const profile = s.profiles.find((p) => p.id === profileId);
  if (!profile?.avatar) return null;
  const fullPath = path.join(avatarsDir(), profile.avatar);
  return fs.existsSync(fullPath) ? fullPath : null;
};

/**
 * Delete the avatar file for `profileId` and clear `profile.avatar`.
 */
export const deleteSpeakerAvatar = async (
  profileId: string,
): Promise<SpeakerProfile> => {
  const s = await read();
  const profile = s.profiles.find((p) => p.id === profileId);
  if (!profile) throw new Error(`profile ${profileId} not found`);

  if (profile.avatar) {
    const fullPath = path.join(avatarsDir(), profile.avatar);
    await fs.remove(fullPath).catch(() => {});
    profile.avatar = undefined;
    profile.updatedAt = new Date().toISOString();
    await write(s);
  }

  return profile;
};
