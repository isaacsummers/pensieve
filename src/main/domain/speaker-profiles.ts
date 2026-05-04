import path from "path";
import fs from "fs-extra";
import { randomUUID } from "crypto";
import { app } from "electron";
import log from "electron-log/main";
import { execa } from "execa";
import * as settings from "./settings";
import { SpeakerProfile } from "../../types";
import { invalidateUiKeys } from "../ipc/invalidate-ui";
import { QueryKeys } from "../../query-keys";

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

export const upsertProfile = async (
  profile: Omit<SpeakerProfile, "id" | "createdAt" | "updatedAt"> &
    Partial<Pick<SpeakerProfile, "id">>,
): Promise<SpeakerProfile> => {
  const s = await read();
  const now = new Date().toISOString();
  const existing = profile.id
    ? s.profiles.find((p) => p.id === profile.id)
    : undefined;
  if (existing) {
    existing.name = profile.name;
    existing.embedding = profile.embedding;
    existing.sampleCount = profile.sampleCount ?? existing.sampleCount ?? 1;
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
 */
const detectCuda = async (): Promise<boolean> => {
  if (process.env.CUDA_PATH && process.env.CUDA_PATH.trim()) {
    return true;
  }
  try {
    const result = await execa("nvidia-smi", ["-L"], {
      stdio: "pipe",
      timeout: 5_000,
      reject: false,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
};

const torchIndexArgs = (cuda: boolean): string[] =>
  cuda ? ["--index-url", "https://download.pytorch.org/whl/cu128"] : [];

/**
 * Create the managed venv if it doesn't already exist. We require `uv` on
 * PATH — this is a hard prerequisite since the rest of the install flow
 * uses `uv pip install --python <venv-python>` to target the venv.
 */
const ensureVenv = async (): Promise<{
  ok: boolean;
  python: string;
  message?: string;
}> => {
  const dir = venvDir();
  const py = venvPythonPath(dir);
  if (fs.existsSync(py)) {
    return { ok: true, python: py };
  }
  await fs.ensureDir(path.dirname(dir));
  log.info(`[speaker-profiles] creating venv at ${dir}`);
  try {
    const result = await execa("uv", ["venv", dir, "--python", "3.12"], {
      stdio: "pipe",
      timeout: 2 * 60_000,
      reject: false,
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        python: py,
        message: `uv venv failed: ${result.stderr || result.stdout}`,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      python: py,
      message: `uv venv failed to launch (is \`uv\` on PATH?): ${msg}`,
    };
  }
  if (!fs.existsSync(py)) {
    return {
      ok: false,
      python: py,
      message: `venv created but python not found at ${py}`,
    };
  }
  return { ok: true, python: py };
};

/** Remove the managed venv directory entirely. Uses sync removal to guarantee
 * the directory is gone before any subsequent `uv venv` call proceeds. */
export const destroyVenv = async (): Promise<void> => {
  const dir = venvDir();
  log.info(`[speaker-profiles] removing venv at ${dir}`);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log.warn("[speaker-profiles] venv removal failed", e);
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
) => {
  const full = ["pip", "install", "--python", python, ...args];
  log.info(`[speaker-profiles] uv ${full.join(" ")}`);
  return execa("uv", full, {
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
  const cuda = await detectCuda();
  log.info(
    `[speaker-profiles] GPU detection: ${cuda ? "CUDA (nvidia)" : "CPU"}`,
  );

  const venv = await ensureVenv();
  if (!venv.ok) {
    return { ok: false, message: venv.message ?? "venv setup failed" };
  }
  const py = venv.python;

  // Step 1: torch + torchaudio with the correct wheel index.
  const torchArgs = torchIndexArgs(cuda);
  const torch = await uvPipInstall(
    py,
    ["torch", "torchaudio", ...torchArgs],
    15 * 60_000,
  );
  if (torch.exitCode !== 0) {
    return {
      ok: false,
      message: `torch install failed: ${torch.stderr || torch.stdout}`,
    };
  }

  // Step 2: core scientific deps.
  const core = await uvPipInstall(
    py,
    ["numpy", "librosa", "decorator"],
    10 * 60_000,
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
  );
  if (resem.exitCode !== 0) {
    return {
      ok: false,
      message: `resemblyzer install failed: ${resem.stderr || resem.stdout}`,
    };
  }

  // webrtcvad-wheels provides the `webrtcvad` module with prebuilt wheels on
  // every supported platform, avoiding the Windows MSVC requirement.
  const vad = await uvPipInstall(py, ["webrtcvad-wheels"], 5 * 60_000);
  if (vad.exitCode !== 0) {
    return {
      ok: false,
      message: `webrtcvad-wheels install failed: ${vad.stderr || vad.stdout}`,
    };
  }

  // umap-learn is used internally by resemblyzer; install non-fatally.
  const umap = await uvPipInstall(py, ["umap-learn"], 5 * 60_000);
  if (umap.exitCode !== 0) {
    log.warn(
      "[speaker-profiles] umap-learn install failed (non-fatal):",
      umap.stderr,
    );
  }

  const note = `torch: ${cuda ? "CUDA 12.8" : "CPU"}${
    isWindows ? "; webrtcvad-wheels" : ""
  }`;
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
  return process.platform === "win32" ? "python" : "python3";
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

  let result;
  try {
    result = await execa(python, fullArgs, {
      stdio: "pipe",
      timeout: opts.timeoutMs ?? 5 * 60_000,
      reject: false,
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
      // Install failed — fall through to original error.
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
      { stage: "embed" },
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
