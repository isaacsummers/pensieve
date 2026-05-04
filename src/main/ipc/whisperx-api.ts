import { execa } from "execa";
import * as whisperx from "../domain/whisperx";

export const whisperxApi = {
  checkInstalled: async () => whisperx.checkWhisperxAvailability(),

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
