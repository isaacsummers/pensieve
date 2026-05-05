/**
 * Zustand slice for live transcription state in the recorder.
 *
 * Manages fragment accumulation, status tracking, and push-event subscription.
 */
import { create } from "zustand";
import { useEffect } from "react";
import { liveTranscriptionApi, liveTranscriptionEvents } from "../api";
import { LiveTranscriptFragment, LiveTranscriptionStatus } from "../../types";

type LiveTranscriptionState = {
  isEnabled: boolean;
  currentRecordingId: string | null;
  status: LiveTranscriptionStatus;
  fragments: LiveTranscriptFragment[];
  error?: string;

  setEnabled: (enabled: boolean) => void;
  /** Called when recording starts (if live transcription is enabled) */
  onRecordingStart: (recordingId: string) => Promise<void>;
  /** Called when a new audio chunk is available from MediaRecorder */
  onAudioChunk: (chunk: Buffer) => void;
  /** Called when recording stops */
  onRecordingStop: () => Promise<void>;
  /** Called on fragment push events from main process */
  _appendFragment: (recordingId: string, fragment: LiveTranscriptFragment) => void;
  /** Called on status push events from main process */
  _updateStatus: (recordingId: string, status: LiveTranscriptionStatus) => void;
};

export const useLiveTranscriptionState = create<LiveTranscriptionState>()(
  (set, get) => ({
    isEnabled: false,
    currentRecordingId: null,
    status: "idle",
    fragments: [],
    error: undefined,

    setEnabled: (enabled) => set({ isEnabled: enabled }),

    onRecordingStart: async (recordingId: string) => {
      if (!get().isEnabled) return;
      set({
        currentRecordingId: recordingId,
        status: "loading",
        fragments: [],
        error: undefined,
      });
      try {
        await liveTranscriptionApi.startLiveTranscription(recordingId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set({ status: "error", error: msg });
      }
    },

    onAudioChunk: (chunk: Buffer) => {
      const { currentRecordingId, status, isEnabled } = get();
      if (!isEnabled || !currentRecordingId) return;
      // Push chunks once active; during "loading" they are buffered in the domain layer
      if (status === "idle" || status === "error") return;
      liveTranscriptionApi.pushAudioChunk(currentRecordingId, chunk);
    },

    onRecordingStop: async () => {
      const { currentRecordingId, isEnabled } = get();
      if (!isEnabled || !currentRecordingId) return;
      set({ status: "finalizing" });
      try {
        await liveTranscriptionApi.stopLiveTranscription(currentRecordingId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set({ status: "error", error: msg });
        return;
      }
      set({ status: "done", currentRecordingId: null });
    },

    _appendFragment: (recordingId, fragment) => {
      if (get().currentRecordingId !== recordingId) return;
      set((prev) => ({ fragments: [...prev.fragments, fragment] }));
    },

    _updateStatus: (recordingId, status) => {
      if (get().currentRecordingId !== recordingId) return;
      set({ status });
    },
  }),
);

/**
 * Hook that subscribes to push events from the main process.
 * Must be mounted once at the app level or inside the recorder component.
 */
export const useLiveTranscriptionEvents = () => {
  const { _appendFragment, _updateStatus } = useLiveTranscriptionState();

  useEffect(() => {
    const offFragment = liveTranscriptionEvents.onFragment(({ recordingId, fragment }) => {
      _appendFragment(recordingId, fragment);
    });
    const offStatus = liveTranscriptionEvents.onStatus(({ recordingId, status }) => {
      _updateStatus(recordingId, status);
    });
    return () => {
      offFragment();
      offStatus();
    };
  }, [_appendFragment, _updateStatus]);
};
