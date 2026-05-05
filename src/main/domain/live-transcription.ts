/**
 * Live transcription domain module.
 *
 * Manages the lifecycle of a faster-whisper sidecar process for each active
 * recording session. Audio flows:
 *
 *   Renderer MediaRecorder (webm) → IPC pushAudioChunk → ffmpeg (PCM stdout)
 *   → Python sidecar stdin → sidecar stdout NDJSON → webContents.send push
 *
 * One sidecar process per recording session. Sidecar is spawned on
 * startLiveTranscription() and terminated on stopLiveTranscription().
 */

import path from "path";
import { ChildProcess, spawn } from "child_process";
import { BrowserWindow } from "electron";
import fs from "fs-extra";
import log from "electron-log/main";
import { getWhisperxProjectDir, getWhisperxVenvPython } from "./whisperx-venv";
import { getRecordingsFolder, saveTranscriptVersion } from "./history";
import { getSettings } from "./settings";
import {
  LiveTranscriptFragment,
  LiveTranscriptionStatus,
  RecordingTranscriptItem,
  TranscriptVersion,
} from "../../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LiveSession = {
  recordingId: string;
  model: string;
  /** ffmpeg process that converts webm → raw PCM */
  ffmpegProc: ChildProcess;
  /** Python faster-whisper sidecar */
  sidecarProc: ChildProcess;
  fragments: LiveTranscriptFragment[];
  status: LiveTranscriptionStatus;
  /** Called when the session is fully cleaned up */
  resolveStop?: () => void;
  /** Buffered webm audio chunks received before ffmpeg is ready */
  pendingChunks: Buffer[];
  ffmpegReady: boolean;
};

// ---------------------------------------------------------------------------
// State (one session per recording at most)
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, LiveSession>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getLiveSidecarScript = (): string => {
  const projectDir = getWhisperxProjectDir();
  return path.join(projectDir, "live_transcribe.py");
};

const notifyFragment = (recordingId: string, fragment: LiveTranscriptFragment) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("liveTranscriptFragment", { recordingId, fragment });
  }
};

const notifyStatus = (recordingId: string, status: LiveTranscriptionStatus) => {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("liveTranscriptStatus", { recordingId, status });
  }
};

/**
 * Convert accumulated LiveTranscriptFragment[] to RecordingTranscriptItem[].
 * The items are sorted by start_ms and speaker is null (filled later by batch).
 */
const fragmentsToTranscriptItems = (
  fragments: LiveTranscriptFragment[],
): RecordingTranscriptItem[] => {
  return fragments
    .filter((f) => f.text.trim().length > 0)
    .sort((a, b) => a.start_ms - b.start_ms)
    .map((f) => ({
      timestamps: {
        from: msToHms(f.start_ms),
        to: msToHms(f.end_ms),
      },
      offsets: { from: f.start_ms, to: f.end_ms },
      text: f.text.trim(),
      speaker: "SPEAKER_00",
    }));
};

const msToHms = (ms: number): string => {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const msRem = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(msRem).padStart(3, "0")}`;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type StartLiveTranscriptionOptions = {
  model?: string;
  device?: string;
  language?: string;
  chunkMs?: number;
  overlapMs?: number;
};

/**
 * Spawn ffmpeg + Python sidecar for a recording session.
 * Resolves when the sidecar has emitted `{"status": "active"}`.
 */
export const startLiveTranscription = async (
  recordingId: string,
  opts?: StartLiveTranscriptionOptions,
): Promise<void> => {
  if (activeSessions.has(recordingId)) {
    log.warn(`[live-transcription] Session already active for ${recordingId}`);
    return;
  }

  const settings = await getSettings();
  const model = opts?.model ?? settings.liveTranscription?.liveModel ?? "base.en";
  const device = opts?.device ?? "cpu";
  const language = opts?.language ?? undefined;
  const chunkMs = opts?.chunkMs ?? 3000;
  const overlapMs = opts?.overlapMs ?? 500;

  const sidecarScript = getLiveSidecarScript();
  const pythonBin = getWhisperxVenvPython();

  if (!fs.existsSync(pythonBin)) {
    throw new Error(
      `[live-transcription] Python venv not found at ${pythonBin}. Run WhisperX setup first.`,
    );
  }

  if (!fs.existsSync(sidecarScript)) {
    throw new Error(
      `[live-transcription] live_transcribe.py not found at ${sidecarScript}`,
    );
  }

  const sidecarArgs = [
    sidecarScript,
    "--model", model,
    "--device", device,
    "--chunk-ms", String(chunkMs),
    "--overlap-ms", String(overlapMs),
    ...(language ? ["--language", language] : []),
  ];

  log.info(`[live-transcription] Starting sidecar: ${pythonBin} ${sidecarArgs.join(" ")}`);

  // ffmpeg converts incoming webm/opus chunks to raw PCM 16kHz mono s16le
  // We pipe webm to ffmpeg stdin and read raw PCM from its stdout.
  const ffmpegBin = "ffmpeg";
  const ffmpegArgs = [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "webm",
    "-i", "pipe:0",
    "-ar", "16000",
    "-ac", "1",
    "-f", "s16le",
    "-acodec", "pcm_s16le",
    "pipe:1",
  ];

  const ffmpegProc = spawn(ffmpegBin, ffmpegArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const sidecarProc = spawn(pythonBin, sidecarArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Pipe ffmpeg stdout → sidecar stdin
  ffmpegProc.stdout!.pipe(sidecarProc.stdin!);

  const session: LiveSession = {
    recordingId,
    model,
    ffmpegProc,
    sidecarProc,
    fragments: [],
    status: "loading",
    pendingChunks: [],
    ffmpegReady: false,
    resolveStop: undefined,
  };
  activeSessions.set(recordingId, session);

  notifyStatus(recordingId, "loading");

  // Parse sidecar stdout NDJSON
  let sidecarBuf = "";
  sidecarProc.stdout!.on("data", (data: Buffer) => {
    sidecarBuf += data.toString("utf8");
    const lines = sidecarBuf.split("\n");
    sidecarBuf = lines.pop() ?? ""; // keep partial last line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.type === "status") {
          const newStatus: LiveTranscriptionStatus =
            msg.status === "loading" ? "loading"
            : msg.status === "active" ? "active"
            : msg.status === "done" ? "done"
            : "error";
          session.status = newStatus;
          notifyStatus(recordingId, newStatus);
          if (msg.status === "active") {
            // Flush any buffered chunks that arrived before the sidecar was ready
            session.ffmpegReady = true;
            for (const chunk of session.pendingChunks) {
              if (!ffmpegProc.stdin!.destroyed) {
                ffmpegProc.stdin!.write(chunk);
              }
            }
            session.pendingChunks = [];
          }
        } else if (msg.type === "fragment") {
          const fragment: LiveTranscriptFragment = {
            seq: msg.seq,
            text: msg.text,
            start_ms: msg.start_ms,
            end_ms: msg.end_ms,
            is_final: msg.is_final,
            language: msg.language,
            speaker: msg.speaker ?? null,
          };
          session.fragments.push(fragment);
          notifyFragment(recordingId, fragment);
        }
      } catch (e) {
        log.warn(`[live-transcription] Failed to parse sidecar line: ${trimmed}`, e);
      }
    }
  });

  sidecarProc.stderr!.on("data", (data: Buffer) => {
    log.info(`[live-transcription][sidecar] ${data.toString("utf8").trim()}`);
  });

  ffmpegProc.stderr!.on("data", (data: Buffer) => {
    log.debug(`[live-transcription][ffmpeg] ${data.toString("utf8").trim()}`);
  });

  sidecarProc.on("exit", (code) => {
    log.info(`[live-transcription] Sidecar exited with code ${code} for ${recordingId}`);
    session.status = "done";
    session.resolveStop?.();
  });

  ffmpegProc.on("exit", (code) => {
    log.debug(`[live-transcription] ffmpeg exited with code ${code} for ${recordingId}`);
  });
};

/**
 * Push a webm audio chunk to the live transcription pipeline for a session.
 */
export const pushAudioChunk = (recordingId: string, chunk: Buffer): void => {
  const session = activeSessions.get(recordingId);
  if (!session) return;

  if (!session.ffmpegReady) {
    // Sidecar not yet active — buffer the chunk
    session.pendingChunks.push(chunk);
    return;
  }

  if (!session.ffmpegProc.stdin!.destroyed) {
    session.ffmpegProc.stdin!.write(chunk);
  }
};

/**
 * Close the live transcription pipeline and save the final TranscriptVersion.
 * Resolves when the sidecar exits.
 */
export const stopLiveTranscription = async (
  recordingId: string,
): Promise<void> => {
  const session = activeSessions.get(recordingId);
  if (!session) return;

  session.status = "finalizing";
  notifyStatus(recordingId, "finalizing");

  // Close ffmpeg stdin — this propagates EOF through ffmpeg → sidecar stdin
  if (!session.ffmpegProc.stdin!.destroyed) {
    session.ffmpegProc.stdin!.end();
  }

  // Wait for sidecar to finish (or timeout after 30s)
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      log.warn(`[live-transcription] Sidecar timeout for ${recordingId}, killing.`);
      session.sidecarProc.kill();
      resolve();
    }, 30_000);
    session.resolveStop = () => {
      clearTimeout(timeout);
      resolve();
    };
    // Already exited?
    if (session.sidecarProc.exitCode !== null) {
      clearTimeout(timeout);
      resolve();
    }
  });

  // Save the final TranscriptVersion
  const versionId = `live-${Date.now()}`;
  const items = fragmentsToTranscriptItems(session.fragments);
  const detectedLanguage = session.fragments[0]?.language ?? undefined;

  const version: TranscriptVersion = {
    id: versionId,
    kind: "live",
    model: session.model,
    createdAt: new Date().toISOString(),
    items,
    status: "final",
    language: detectedLanguage,
  };

  try {
    await saveTranscriptVersion(recordingId, version);
    log.info(
      `[live-transcription] Saved live TranscriptVersion ${versionId} with ${items.length} items`,
    );
  } catch (e) {
    log.error(`[live-transcription] Failed to save TranscriptVersion`, e);
  }

  activeSessions.delete(recordingId);
};

/**
 * Return the current list of fragments for a session (for polling fallback).
 */
export const getLiveTranscript = (
  recordingId: string,
): LiveTranscriptFragment[] => {
  return activeSessions.get(recordingId)?.fragments ?? [];
};

/**
 * Return the current status of a live transcription session.
 */
export const getLiveTranscriptionStatus = (
  recordingId: string,
): LiveTranscriptionStatus => {
  return activeSessions.get(recordingId)?.status ?? "idle";
};
