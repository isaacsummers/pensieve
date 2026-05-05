import path from "path";
import fs from "fs-extra";
import { app } from "electron";

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

const isDev = (): boolean => process.env.NODE_ENV === "development";

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
  return path.join(app.getPath("userData"), "pensieve-whisperx");
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
    try {
      const [srcStat, dstStat] = await Promise.all([
        fs.stat(source),
        fs.stat(dest),
      ]);
      if (srcStat.mtimeMs > dstStat.mtimeMs) needCopy = true;
    } catch {
      needCopy = true;
    }
  }
  if (needCopy) {
    await fs.copy(source, dest, { overwrite: true });
  }

  return dir;
};
