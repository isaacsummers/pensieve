import path from "path";
import fs from "fs-extra";
import { app, shell } from "electron";
import {
  AdditionalMicFile,
  RecordingData,
  RecordingMeta,
  RecordingTranscript,
  TranscriptVersion,
  TranscriptVersionSummary,
} from "../../types";
import { invalidateUiKeys } from "../ipc/invalidate-ui";
import { QueryKeys } from "../../query-keys";
import * as searchIndex from "./search";
import * as ffmpeg from "./ffmpeg";
import * as settings from "./settings";
import * as postprocess from "./postprocess";
import { getDuration } from "./ffmpeg";
import { planAdditionalMicFiles } from "./recording-files";

export const getRecordingsFolder = async () => {
  return (await settings.getSettings()).core.recordingsFolder;
};

export const init = async () => {
  await fs.ensureDir(await getRecordingsFolder());
};

export const getUnassociatedImagesFolder = () => {
  return path.join(app.getPath("userData"), "unassociated-images");
};

export const storeUnassociatedScreenshot = async (
  fileName: string,
  data: Uint8Array,
) => {
  if (!fileName.endsWith(".png")) {
    throw new Error("Only PNG files are supported");
  }

  await fs.outputFile(path.join(getUnassociatedImagesFolder(), fileName), data);
};

export const saveRecording = async (recording: RecordingData) => {
  const started = new Date(recording.meta.started);
  // Plan additional mic file names up front so we can record them in meta.
  const additionalPlan = planAdditionalMicFiles(
    recording.additionalMicTracks ?? [],
  );
  const additionalMicFiles: AdditionalMicFile[] = additionalPlan.map(
    (p) => p.file,
  );

  const meta: RecordingMeta = {
    duration: Date.now() - started.getTime(),
    isPostProcessed: false,
    hasRawRecording: true,
    hasMic: !!recording.mic,
    hasScreen: !!recording.screen,
    additionalMicFiles:
      additionalMicFiles.length > 0 ? additionalMicFiles : undefined,
    ...recording.meta,
  };

  const recordingId = `${started.getFullYear()}-${started.getMonth() + 1}-${started.getDate()}_${started.getHours()}-${started.getMinutes()}-${started.getSeconds()}`;
  const folder = path.join(await getRecordingsFolder(), recordingId);
  await fs.ensureDir(folder);
  if (recording.mic) {
    await fs.writeFile(
      path.join(folder, "mic.webm"),
      Buffer.from(recording.mic),
    );
  }
  for (const { track, file } of additionalPlan) {
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(
      path.join(folder, file.fileName),
      Buffer.from(track.data),
    );
  }
  if (recording.screen) {
    await fs.writeFile(
      path.join(folder, "screen.webm"),
      Buffer.from(recording.screen),
    );
  }
  await fs.writeJSON(path.join(folder, "meta.json"), meta, {
    spaces: 2,
  });

  for (const screenshot of Object.values(recording.meta.screenshots ?? {})) {
    await fs.move(
      path.join(getUnassociatedImagesFolder(), screenshot),
      path.join(folder, screenshot),
    );
  }

  searchIndex.updateRecordingName(folder, recording.meta.name);
  invalidateUiKeys(QueryKeys.History);

  if ((await settings.getSettings()).ffmpeg.autoTriggerPostProcess) {
    postprocess.addToQueue({ recordingId });
    postprocess.startQueue();
  }
};

export const importRecording = async (file: string, meta: RecordingMeta) => {
  const date = new Date(meta.started);
  const recordingId = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}_${date.getHours()}-${date.getMinutes()}-${date.getSeconds()}`;
  const folder = path.join(await getRecordingsFolder(), recordingId);
  await fs.ensureDir(folder);
  await ffmpeg.simpleTranscode(file, path.join(folder, "screen.webm"));
  const fullMeta: RecordingMeta = {
    ...meta,
    isImported: true,
    duration: await getDuration(file),
  };
  await fs.writeJSON(path.join(folder, "meta.json"), fullMeta, {
    spaces: 2,
  });
  searchIndex.updateRecordingName(folder, fullMeta.name);
  invalidateUiKeys(QueryKeys.History);

  if ((await settings.getSettings()).ffmpeg.autoTriggerPostProcess) {
    postprocess.addToQueue({ recordingId });
    postprocess.startQueue();
  }
};

export const listRecordings = async () => {
  const recordingFolders = await fs.readdir(await getRecordingsFolder());

  // Filter out non-directories and .DS_Store files first
  const validFolders = [];
  for (const folder of recordingFolders) {
    // Skip .DS_Store and other hidden files
    if (folder.startsWith(".")) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const folderPath = path.join(await getRecordingsFolder(), folder);
    const stats = await fs.stat(folderPath);
    if (stats.isDirectory()) {
      validFolders.push(folder);
    }
  }

  const items = await Promise.all(
    validFolders.map(
      async (recordingFolder) =>
        [
          recordingFolder,
          (await fs.readJson(
            path.join(
              await getRecordingsFolder(),
              recordingFolder,
              "meta.json",
            ),
          )) as RecordingMeta,
        ] as const,
    ),
  );
  return items.reverse().reduce(
    (acc, [folder, meta]) => {
      acc[folder] = meta;
      return acc;
    },
    {} as Record<string, RecordingMeta>,
  );
};

export const getRecordingMeta = async (
  recordingId: string,
): Promise<RecordingMeta> =>
  fs.readJson(path.join(await getRecordingsFolder(), recordingId, "meta.json"));

export const getRecordingTranscript = async (
  recordingId: string,
): Promise<RecordingTranscript | null> => {
  const file = path.join(
    await getRecordingsFolder(),
    recordingId,
    "transcript.json",
  );
  return fs.existsSync(file) ? fs.readJson(file) : null;
};

export const getRecordingAudioFile = async (id: string) => {
  const mp3 = path.join(await getRecordingsFolder(), id, "recording.mp3");
  return fs.existsSync(mp3) ? `file://${mp3}` : null;
};

export const updateRecording = async (
  recordingId: string,
  partial: Partial<RecordingMeta>,
) => {
  const meta = await fs.readJson(
    path.join(await getRecordingsFolder(), recordingId, "meta.json"),
  );
  await fs.writeJson(
    path.join(await getRecordingsFolder(), recordingId, "meta.json"),
    {
      ...meta,
      ...partial,
    },
    { spaces: 2 },
  );
  searchIndex.updateRecordingName(recordingId, partial.name);
  invalidateUiKeys(QueryKeys.History, recordingId);
  invalidateUiKeys(QueryKeys.History);
};

export const openRecordingFolder = async (recordingId: string) => {
  const folder = path.join(await getRecordingsFolder(), recordingId);
  await shell.openPath(folder);
};

export const removeRecording = async (recordingId: string) => {
  await fs.remove(path.join(await getRecordingsFolder(), recordingId));
  searchIndex.removeRecordingFromIndex(recordingId);
  invalidateUiKeys(QueryKeys.History);
};

// ---------------------------------------------------------------------------
// Transcript Version Helpers
// ---------------------------------------------------------------------------

const transcriptVersionFileName = (versionId: string, kind: "live" | "batch") =>
  `transcript-${kind}-${versionId}.json`;

/**
 * Persist a full TranscriptVersion to disk and update the meta index.
 */
export const saveTranscriptVersion = async (
  recordingId: string,
  version: TranscriptVersion,
): Promise<void> => {
  const folder = path.join(await getRecordingsFolder(), recordingId);
  const filePath = path.join(folder, transcriptVersionFileName(version.id, version.kind));
  await fs.writeJSON(filePath, version, { spaces: 2 });

  // Build lightweight summary for the meta index
  const summary: TranscriptVersionSummary = {
    id: version.id,
    kind: version.kind,
    model: version.model,
    createdAt: version.createdAt,
    status: version.status,
    itemCount: version.items.length,
    error: version.error,
  };

  const meta = await getRecordingMeta(recordingId);
  const existing = meta.transcriptVersions ?? [];
  // Replace if already exists (e.g. status update from "partial" to "final")
  const idx = existing.findIndex((v) => v.id === version.id);
  const updated = idx >= 0
    ? [...existing.slice(0, idx), summary, ...existing.slice(idx + 1)]
    : [summary, ...existing]; // prepend so newest-first

  await updateRecording(recordingId, { transcriptVersions: updated });
};

/**
 * Load a full TranscriptVersion from disk.
 */
export const loadTranscriptVersion = async (
  recordingId: string,
  versionId: string,
): Promise<TranscriptVersion | null> => {
  const folder = path.join(await getRecordingsFolder(), recordingId);
  // Try both kinds
  for (const kind of ["live", "batch"] as const) {
    const filePath = path.join(folder, transcriptVersionFileName(versionId, kind));
    if (fs.existsSync(filePath)) {
      return fs.readJson(filePath) as Promise<TranscriptVersion>;
    }
  }
  return null;
};

/**
 * List all transcript version summaries for a recording.
 */
export const listTranscriptVersions = async (
  recordingId: string,
): Promise<TranscriptVersionSummary[]> => {
  const meta = await getRecordingMeta(recordingId);
  return meta.transcriptVersions ?? [];
};

/**
 * Set which transcript version is active (shown by default).
 */
export const setActiveTranscriptVersion = async (
  recordingId: string,
  versionId: string,
): Promise<void> => {
  await updateRecording(recordingId, { activeTranscriptVersionId: versionId });
};

/**
 * Load the active transcript version. Falls back to the legacy
 * transcript.json if no versioned transcripts exist.
 */
export const getActiveTranscriptVersion = async (
  recordingId: string,
): Promise<TranscriptVersion | null> => {
  const meta = await getRecordingMeta(recordingId);
  if (meta.activeTranscriptVersionId) {
    const version = await loadTranscriptVersion(recordingId, meta.activeTranscriptVersionId);
    if (version) return version;
  }
  // No active version — fall back to legacy transcript.json
  const legacy = await getRecordingTranscript(recordingId);
  if (!legacy) return null;
  // Wrap in a TranscriptVersion shape for uniform consumption
  return {
    id: "legacy",
    kind: "batch",
    model: "unknown",
    createdAt: meta.started ?? new Date().toISOString(),
    items: legacy.transcription,
    status: "done",
    language: legacy.result.language,
  };
};
