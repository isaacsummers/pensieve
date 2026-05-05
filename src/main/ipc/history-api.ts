import { dialog } from "electron";
import fs from "fs-extra";
import * as history from "../domain/history";
import * as postprocess from "../domain/postprocess";
import * as searchIndex from "../domain/search";
import { openAppWindow } from "../domain/windows";
import { PostProcessingJob, TranscriptVersion } from "../../types";

export const historyApi = {
  storeUnassociatedScreenshot: history.storeUnassociatedScreenshot,
  saveRecording: history.saveRecording,
  importRecording: history.importRecording,
  getRecordings: history.listRecordings,
  updateRecordingMeta: history.updateRecording,
  getRecordingMeta: history.getRecordingMeta,
  getRecordingTranscript: history.getRecordingTranscript,
  getRecordingAudioFile: history.getRecordingAudioFile,
  openRecordingFolder: history.openRecordingFolder,
  removeRecording: history.removeRecording,

  // Transcript version helpers
  loadTranscriptVersion: async (recordingId: string, versionId: string) =>
    history.loadTranscriptVersion(recordingId, versionId),
  listTranscriptVersions: async (recordingId: string) =>
    history.listTranscriptVersions(recordingId),
  setActiveTranscriptVersion: async (recordingId: string, versionId: string) =>
    history.setActiveTranscriptVersion(recordingId, versionId),
  getActiveTranscriptVersion: async (recordingId: string) =>
    history.getActiveTranscriptVersion(recordingId),

  /**
   * Queue a re-processing job for an existing recording using a specific
   * Whisper model. Skips wav/mp3 conversion (already done) and saves the
   * result as a new TranscriptVersion rather than overwriting transcript.json.
   */
  reprocessWithModel: async (
    recordingId: string,
    model: string,
  ): Promise<void> => {
    postprocess.addToQueue({
      recordingId,
      steps: ["whisper"],
      whisperOptions: { saveAsVersion: true, modelOverride: model },
    });
    postprocess.startQueue();
  },

  search: async (query: string) => searchIndex.search(query),

  startPostProcessing: async () => postprocess.startQueue(),
  stopPostProcessing: async () => postprocess.stop(),
  addToPostProcessingQueue: async (
    job: Pick<PostProcessingJob, "recordingId"> &
      Partial<Omit<PostProcessingJob, "recordingId">>,
  ) => postprocess.addToQueue(job),
  getPostProcessingProgress: async () => postprocess.getProgressData(),
  clearPostProcessingQueue: async () => postprocess.clearList(),
  removeFromPostProcessingQueue: async (id: string) =>
    postprocess.removeFromQueue(id),
  cancelPostProcessingItem: async (id: string) => {
    // Item-level cancel: cancels in-flight item or removes a queued one.
    postprocess.removeFromQueue(id);
  },
  retryPostProcessingItem: async (id: string) => postprocess.retryItem(id),
  reorderPostProcessingItem: async (id: string, afterId: string | null) =>
    postprocess.reorderItem(id, afterId),
  retryAllFailedPostProcessing: async () => postprocess.retryAllFailed(),
  clearCompletedPostProcessing: async () => postprocess.clearCompleted(),

  openRecordingDetailsWindow: async (id: string) => {
    openAppWindow(`/history/${id}`, {}, { minWidth: 400, minHeight: 400 });
  },

  showOpenImportDialog: async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Import Recording",
      buttonLabel: "Import",
      properties: ["openFile"],
    });
    if (canceled || !filePaths[0]) {
      return null;
    }
    const fileCreationDate = fs.statSync(filePaths[0]).birthtime;
    return { filePath: filePaths[0], fileCreationDate };
  },
};
