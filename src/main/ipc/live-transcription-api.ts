import * as liveTx from "../domain/live-transcription";
import { StartLiveTranscriptionOptions } from "../domain/live-transcription";
import { LiveTranscriptFragment, LiveTranscriptionStatus } from "../../types";

export const liveTranscriptionApi = {
  startLiveTranscription: async (
    recordingId: string,
    options?: StartLiveTranscriptionOptions,
  ): Promise<void> => liveTx.startLiveTranscription(recordingId, options),

  stopLiveTranscription: async (recordingId: string): Promise<void> =>
    liveTx.stopLiveTranscription(recordingId),

  pushAudioChunk: async (recordingId: string, chunk: Buffer): Promise<void> => {
    liveTx.pushAudioChunk(recordingId, chunk);
  },

  getLiveTranscript: async (
    recordingId: string,
  ): Promise<LiveTranscriptFragment[]> => liveTx.getLiveTranscript(recordingId),

  getLiveTranscriptionStatus: async (
    recordingId: string,
  ): Promise<LiveTranscriptionStatus> =>
    liveTx.getLiveTranscriptionStatus(recordingId),
};
