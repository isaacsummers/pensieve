import path from "path";
import fs from "fs-extra";
import { execa } from "execa";
import log from "electron-log/main";
import { getSettings } from "./settings";

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

export const getCudaInstallState = (): CudaInstallState => ({ ...installState });

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
 *   1. explicit `whisperx.pythonPath` setting
 *   2. uv-managed tool env: `uv tool dir whisperx` → `<dir>/Scripts|bin/python`
 *   3. null (caller treats as "couldn't introspect")
 */
export const resolveWhisperxPython = async (): Promise<string | null> => {
  const s = (await getSettings()).whisperx;
  const explicit = s.pythonPath?.trim();
  if (explicit) return explicit;

  try {
    const r = await execa("uv", ["tool", "dir", "whisperx"], {
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
    const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const available = /^true$/i.test(lines[0] ?? "");
    const version = lines[1] ?? null;
    return { available, version };
  } catch {
    return { available: false, version: null };
  }
};

// --- public: checkCudaHealth -------------------------------------------------

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

const INSTALL_TIMEOUT_MS = 10 * 60_000;

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

  const python = await resolveWhisperxPython();
  if (!python) {
    return {
      ok: false,
      error:
        "Could not locate the WhisperX Python interpreter. Set Settings → " +
        "WhisperX → Python interpreter, or install whisperx with `uv tool install whisperx`.",
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

  const args = [
    "-m",
    "pip",
    "install",
    "torch",
    "torchvision",
    "torchaudio",
    "--index-url",
    indexUrl,
    "--force-reinstall",
  ];

  log.info(`[whisperx-cuda] reinstalling torch via ${python} ${args.join(" ")}`);
  appendLog(`$ ${python} ${args.join(" ")}\n`);

  try {
    const proc = execa(python, args, {
      stdio: "pipe",
      timeout: INSTALL_TIMEOUT_MS,
      reject: false,
    });
    proc.stdout?.on("data", (d: Buffer) => appendLog(d.toString()));
    proc.stderr?.on("data", (d: Buffer) => appendLog(d.toString()));
    const r = await proc;

    if (r.exitCode === 0) {
      installState = {
        ...installState,
        inProgress: false,
        finishedAt: new Date().toISOString(),
        ok: true,
        error: null,
      };
      return { ok: true };
    }
    const errMsg = `pip exited with code ${r.exitCode}`;
    installState = {
      ...installState,
      inProgress: false,
      finishedAt: new Date().toISOString(),
      ok: false,
      error: errMsg,
    };
    return { ok: false, error: errMsg };
  } catch (e) {
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
