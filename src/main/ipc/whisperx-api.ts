import { execa } from "execa";
import * as whisperx from "../domain/whisperx";
import * as whisperxCuda from "../domain/whisperx-cuda";

export const whisperxApi = {
  checkInstalled: async () => whisperx.checkWhisperxAvailability(),

  /**
   * Surface the most recent Hugging Face 401/403 / gated-repo error seen
   * while running WhisperX diarization. The settings UI uses this to
   * render an actionable callout with links to accept pyannote terms and
   * mint a new HF token. Returns `null` when there is no pending failure.
   */
  getHfAuthError: async () => whisperx.getLastHfAuthError(),

  clearHfAuthError: async () => {
    whisperx.clearLastHfAuthError();
  },

  /**
   * Probe the host for an NVIDIA GPU and verify that the WhisperX Python
   * environment has a CUDA-capable torch installed. Used by the settings
   * UI to surface an actionable warning + remediation button when the
   * user has a GPU but only CPU torch (the default for `uv tool install
   * whisperx`), which crashes WhisperX with `cublas64_12.dll not found`
   * on first run.
   */
  checkCudaHealth: async () => whisperxCuda.checkCudaHealth(),

  /**
   * Reinstall torch + torchvision + torchaudio against the supplied
   * PyTorch wheel index (e.g. `https://download.pytorch.org/whl/cu124`)
   * into the WhisperX Python environment. Streams progress into a
   * module-level state queryable via `getCudaInstallState`.
   */
  reinstallCudaTorch: async (indexUrl: string) =>
    whisperxCuda.reinstallCudaTorch(indexUrl),

  getCudaInstallState: async () => whisperxCuda.getCudaInstallState(),

  testTranscriptionPipeline: async (): Promise<{
    ok: boolean;
    whisperx: { ok: boolean; version?: string; error?: string };
    ffmpeg: { ok: boolean; version?: string; error?: string };
    message: string;
  }> => {
    const wxResult = await whisperx.checkWhisperxAvailability();

    let ffmpegResult: { ok: boolean; version?: string; error?: string };
    try {
      const r = await execa("ffmpeg", ["-version"], {
        stdio: "pipe",
        timeout: 10_000,
        reject: false,
      });
      if (r.exitCode === 0) {
        const version = /ffmpeg version ([\S]+)/i.exec(
          r.stdout + r.stderr,
        )?.[1];
        ffmpegResult = { ok: true, version };
      } else {
        ffmpegResult = {
          ok: false,
          error: `ffmpeg exited with code ${r.exitCode}`,
        };
      }
    } catch (err) {
      ffmpegResult = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const ok = wxResult.ok && ffmpegResult.ok;
    const parts: string[] = [];
    if (wxResult.ok) {
      parts.push(
        `WhisperX${wxResult.version ? ` v${wxResult.version}` : ""} — OK`,
      );
    } else {
      parts.push(
        `WhisperX not found: ${wxResult.error ?? "unknown error"}. Install with \`uv tool install whisperx\` (or \`pipx install whisperx\`).`,
      );
    }
    if (ffmpegResult.ok) {
      parts.push(
        `ffmpeg${ffmpegResult.version ? ` ${ffmpegResult.version}` : ""} — OK`,
      );
    } else {
      parts.push(
        `ffmpeg not found: ${ffmpegResult.error ?? "unknown error"}. Install with \`brew install ffmpeg\` (macOS) or your system package manager.`,
      );
    }

    return {
      ok,
      whisperx: wxResult,
      ffmpeg: ffmpegResult,
      message: parts.join(" · "),
    };
  },
};
