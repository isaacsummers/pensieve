import { createRendererIpc } from "./create-renderer-ipc";
import type { mainApi as mainApiBackend } from "../main/ipc/main-api";
import type { windowsApi as windowsApiBackend } from "../main/ipc/windows-api";
import type { modelsApi as modelsApiBackend } from "../main/ipc/models-api";
import type { whisperxApi as whisperxApiBackend } from "../main/ipc/whisperx-api";
import type { ffmpegApi as ffmpegApiBackend } from "../main/ipc/ffmpeg-api";
import type { historyApi as historyApiBackend } from "../main/ipc/history-api";
import type { speakerProfilesApi as speakerProfilesApiBackend } from "../main/ipc/speaker-profiles-api";
import type { llmApi as llmApiBackend } from "../main/ipc/llm-api";
import type { recorderIpcApi as recorderIpcApiBackend } from "../main/ipc/recorder-ipc";
import type { liveTranscriptionApi as liveTranscriptionApiBackend } from "../main/ipc/live-transcription-api";
import type { LiveTranscriptFragment, LiveTranscriptionStatus } from "../types";

export const mainApi = createRendererIpc<typeof mainApiBackend>("main");
export const windowsApi =
  createRendererIpc<typeof windowsApiBackend>("windows");
export const modelsApi = createRendererIpc<typeof modelsApiBackend>("models");
export const whisperxApi =
  createRendererIpc<typeof whisperxApiBackend>("whisperx");
export const ffmpegApi = createRendererIpc<typeof ffmpegApiBackend>("ffmpeg");
export const historyApi =
  createRendererIpc<typeof historyApiBackend>("history");
export const speakerProfilesApi =
  createRendererIpc<typeof speakerProfilesApiBackend>("speakerProfiles");
export const llmApi = createRendererIpc<typeof llmApiBackend>("llm");
export const recorderIpcApi =
  createRendererIpc<typeof recorderIpcApiBackend>("recorderIpc");
export const liveTranscriptionApi =
  createRendererIpc<typeof liveTranscriptionApiBackend>("liveTranscription");

/** Push-event subscriptions exposed by the preload layer for live transcription */
export const liveTranscriptionEvents = {
  onFragment: (
    listener: (data: { recordingId: string; fragment: LiveTranscriptFragment }) => void,
  ) => (window as any).ipcApi.liveTranscription.onFragment(listener),
  onStatus: (
    listener: (data: { recordingId: string; status: LiveTranscriptionStatus }) => void,
  ) => (window as any).ipcApi.liveTranscription.onStatus(listener),
};
