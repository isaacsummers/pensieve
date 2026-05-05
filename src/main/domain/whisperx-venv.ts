import path from "path";
import fs from "fs-extra";
import { execa } from "execa";
import log from "electron-log/main";
import {
  getUserDataFolder,
  getUvExecutable,
  isDevBuild,
} from "../../main-utils";

/**
 * Project-managed WhisperX Python environment.
 *
 * Instead of relying on `uv tool install whisperx` (which always pulls
 * CPU-only torch from PyPI and forces us to patch the env in post-install),
 * we ship a `pyproject.toml` that declares whisperx + torch with the
 * PyTorch CUDA wheel index configured via `[tool.uv.sources]`. The app
 * runs `uv sync` against that project to materialize a venv with the
 * correct CUDA torch resolved up front.
 *
 * Layout:
 *   - dev mode      → `<repo>/python/`               (pyproject.toml + .venv)
 *   - packaged app  → `<userData>/pensieve-whisperx/` (pyproject.toml copied
 *                                                     from extraResources,
 *                                                     .venv created in place)
 */

const isDev = (): boolean => isDevBuild();

/**
 * Repo root in dev mode. The compiled main process lives at
 * `<repo>/.vite/build/main.js`, so `__dirname` is `<repo>/.vite/build`.
 */
const getRepoRoot = (): string => path.join(__dirname, "../..");

/**
 * Source pyproject.toml inside the packaged app's extraResources.
 * `process.resourcesPath` exists at runtime in packaged Electron.
 */
const getPackagedPyprojectSource = (): string =>
  path.join(process.resourcesPath, "extra", "whisperx-pyproject.toml");

/**
 * Directory holding the WhisperX project (pyproject.toml + .venv).
 * Use this as the cwd for `uv sync`.
 */
export const getWhisperxProjectDir = (): string => {
  if (isDev()) return path.join(getRepoRoot(), "python");
  return path.join(getUserDataFolder(), "pensieve-whisperx");
};

/**
 * Path to the venv directory inside the project dir.
 */
export const getWhisperxVenvDir = (): string =>
  path.join(getWhisperxProjectDir(), ".venv");

/**
 * Path to the Python interpreter inside the project venv.
 * Caller should check existence — the venv may not be created yet.
 */
export const getWhisperxVenvPython = (): string => {
  const venv = getWhisperxVenvDir();
  return process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python");
};

/**
 * Path to the whisperx CLI inside the project venv.
 * Caller should check existence — the venv may not be created yet.
 */
export const getWhisperxVenvBinary = (): string => {
  const venv = getWhisperxVenvDir();
  return process.platform === "win32"
    ? path.join(venv, "Scripts", "whisperx.exe")
    : path.join(venv, "bin", "whisperx");
};

/**
 * Ensure the WhisperX project directory exists with a pyproject.toml
 * present, ready for `uv sync`. In dev mode this is a no-op (the file
 * is committed to the repo); in packaged mode we copy the bundled
 * pyproject.toml from extraResources into userData on first use.
 *
 * Returns the project directory path so callers can chain it directly
 * into an `execa("uv", ["sync"], { cwd })` call.
 */
export const ensureWhisperxProjectDir = async (): Promise<string> => {
  const dir = getWhisperxProjectDir();

  if (isDev()) {
    // Dev mode: pyproject.toml is checked in at <repo>/python/pyproject.toml.
    // Nothing to copy — just confirm it exists so failures surface early.
    const pyproject = path.join(dir, "pyproject.toml");
    if (!(await fs.pathExists(pyproject))) {
      throw new Error(
        `WhisperX pyproject.toml not found at ${pyproject}. ` +
          `Expected the repo to contain python/pyproject.toml.`,
      );
    }
    return dir;
  }

  // Packaged mode: copy the bundled pyproject.toml into userData so uv
  // can manage the venv there. Re-copy if the bundled file is newer than
  // the userData copy (e.g. after an app update changed dependencies).
  await fs.ensureDir(dir);
  const dest = path.join(dir, "pyproject.toml");
  const source = getPackagedPyprojectSource();

  if (!(await fs.pathExists(source))) {
    throw new Error(
      `Bundled WhisperX pyproject.toml missing at ${source}. ` +
        `This is a packaging bug — please report it.`,
    );
  }

  let needCopy = !(await fs.pathExists(dest));
  if (!needCopy) {
    // Compare bundled vs userData copy byte-for-byte. mtime comparison is
    // unreliable across installer types (Squirrel often preserves source
    // mtimes; macOS DMG resets them), so a content compare is the only
    // way to reliably notice a dependency change after an app update.
    try {
      const [srcBuf, dstBuf] = await Promise.all([
        fs.readFile(source),
        fs.readFile(dest),
      ]);
      if (!srcBuf.equals(dstBuf)) needCopy = true;
    } catch {
      needCopy = true;
    }
  }
  if (needCopy) {
    await fs.copy(source, dest, { overwrite: true });
  }

  return dir;
};

// One-shot guard so concurrent processWavFile / availability checks don't
// stampede `uv sync`. Resolves to `true` on success, `false` on failure;
// callers can inspect and decide whether to surface a warning.
let ensureVenvInFlight: Promise<boolean> | null = null;
let ensureVenvDone = false;

/**
 * Ensure the project venv exists by running `uv sync` against the
 * pyproject.toml on disk. No-op when the venv's whisperx entry-point
 * already exists. Safe to call concurrently — syncs are deduplicated.
 */
export const ensureWhisperxVenv = async (): Promise<boolean> => {
  if (ensureVenvDone) return true;
  if (ensureVenvInFlight) return ensureVenvInFlight;

  ensureVenvInFlight = (async () => {
    const venvBin = getWhisperxVenvBinary();
    const venvPython = getWhisperxVenvPython();
    if (fs.existsSync(venvBin) || fs.existsSync(venvPython)) {
      ensureVenvDone = true;
      return true;
    }
    let projectDir: string;
    try {
      projectDir = await ensureWhisperxProjectDir();
    } catch (e) {
      log.warn(
        `[whisperx-venv] could not prepare project dir: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return false;
    }

    const uv = getUvExecutable();
    log.info(
      `[whisperx-venv] venv missing; running first-run \`uv sync\` in ${projectDir} (uv=${uv})`,
    );
    try {
      const r = await execa(uv, ["sync"], {
        cwd: projectDir,
        stdio: "pipe",
        timeout: 10 * 60_000,
        reject: false,
      });
      if (r.exitCode === 0) {
        log.info(`[whisperx-venv] first-run uv sync completed`);
        ensureVenvDone = true;
        return true;
      }
      log.warn(
        `[whisperx-venv] first-run uv sync exited ${r.exitCode}: ${
          r.stderr || r.stdout
        }`,
      );
      return false;
    } catch (e) {
      log.warn(
        `[whisperx-venv] first-run uv sync failed to launch: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return false;
    }
  })();

  try {
    return await ensureVenvInFlight;
  } finally {
    ensureVenvInFlight = null;
  }
};
