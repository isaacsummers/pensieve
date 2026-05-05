import { create } from "zustand";
import { useCallback } from "react";
import { historyApi, mainApi, recorderIpcApi } from "../api";
import { blobToBuffer } from "../../utils";
import { CapturedMicTrack, RecordingConfig, RecordingMeta } from "../../types";
import { MicTrack, createRecorder } from "./create-recorder";

type RecorderState = {
  recorder?: { screen: MediaRecorder | null; mic: MicTrack[] };
  meta: RecordingMeta;
  recordingConfig: RecordingConfig;
  isPaused: boolean;
  isRecording: boolean;

  getCurrentTime: () => number;
  setMeta: (meta: Partial<RecordingMeta>) => void;
  setConfig: (config: Partial<RecordingConfig>) => void;
  hydrateFromSettings: () => Promise<void>;
  startRecording: () => Promise<void>;
  reset: () => void;
  pause: () => void;
  resume: () => void;
  addHighlight: () => void;
  addTimestampedNote: (note: string) => void;
  addScreenshot: (fileName: string) => void;
};

export const useRecorderState = create<RecorderState>()((_set, get) => {
  const set: typeof _set = (newState) => {
    if (typeof newState === "function") {
      _set((state) => {
        const result = newState(state);
        recorderIpcApi.setState({
          meta: result.meta,
          isRecording: result.isRecording,
          isPaused: result.isPaused,
        });
        return result;
      });
      return;
    }

    _set(newState);
    recorderIpcApi.setState({
      meta: newState.meta,
      isRecording: newState.isRecording,
      isPaused: newState.isPaused,
    });
  };

  return {
    recordingConfig: { recordScreenAudio: true },
    meta: { started: new Date().toISOString() },
    isRecording: false,
    isPaused: false,

    getCurrentTime: () =>
      new Date().getTime() - new Date(get().meta.started).getTime(),

    setMeta: (meta: Partial<RecordingMeta>) =>
      set({ meta: { ...get().meta, ...meta } }),
    setConfig: (config) => {
      const next = { ...get().recordingConfig, ...config };
      set({ recordingConfig: next });
      // Fire-and-forget persist. We persist `micEnabled` from the truthiness
      // of `mic` so toggling the recording-mic checkbox round-trips.
      mainApi
        .updateRecordingSettings({
          micEnabled: !!next.mic,
          selectedMicDeviceId: next.mic?.deviceId ?? null,
          additionalAudioDevices: (next.additionalAudioDevices ?? []).map(
            (d) => ({
              deviceId: d.deviceId,
              kind: d.kind === "audiooutput" ? "output" : "input",
            }),
          ),
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("Failed to persist recording settings", err);
        });
    },
    hydrateFromSettings: async () => {
      try {
        const settings = await mainApi.getSettings();
        const { recording } = settings;
        if (!recording) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");
        const audioOutputs = devices.filter((d) => d.kind === "audiooutput");

        // Resolve primary mic: by id first, then label, then default.
        const findInput = (deviceId: string | null) => {
          if (!deviceId) return undefined;
          const byId = audioInputs.find((d) => d.deviceId === deviceId);
          if (byId) return byId;
          // OQ-5: fall back to label-match if the saved id has rotated.
          // Without a stored label we can't match here — the additional-
          // devices block stores label info via deviceId only too. Practical
          // mismatches show up there, so primary just falls through.
          return undefined;
        };
        const primary =
          findInput(recording.selectedMicDeviceId) ?? audioInputs[0];

        // Resolve additional devices preserving stored kind.
        const additional: MediaDeviceInfo[] = [];
        for (const stored of recording.additionalAudioDevices ?? []) {
          const pool = stored.kind === "output" ? audioOutputs : audioInputs;
          const match = pool.find((d) => d.deviceId === stored.deviceId);
          if (match) additional.push(match);
        }

        set({
          recordingConfig: {
            recordScreenAudio: get().recordingConfig.recordScreenAudio ?? true,
            mic: recording.micEnabled ? primary : undefined,
            additionalAudioDevices: additional,
          },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("Failed to hydrate recording settings", err);
      }
    },
    startRecording: async () => {
      set({
        recorder: await createRecorder(get().recordingConfig),
        meta: { ...get().meta, started: new Date().toISOString() },
        isRecording: true,
        isPaused: false,
      });
    },
    reset: async () =>
      set({
        recordingConfig: {
          recordScreenAudio: true,
          mic: (await navigator.mediaDevices.enumerateDevices()).find(
            (d) => d.kind === "audioinput",
          ),
        },
        recorder: undefined,
        meta: undefined,
        isRecording: false,
        isPaused: false,
      }),
    pause: () => {
      get().recorder?.mic?.forEach((t) => t.recorder.pause());
      get().recorder?.screen?.pause();
      set({ isPaused: true });
    },
    resume: () => {
      get().recorder?.mic?.forEach((t) => t.recorder.resume());
      get().recorder?.screen?.resume();
      set({ isPaused: false });
    },
    addHighlight: () => {
      set({
        meta: {
          ...get().meta,
          highlights: [
            ...(get().meta.highlights ?? []),
            get().getCurrentTime(),
          ],
        },
      });
    },
    addTimestampedNote: (note: string) => {
      set({
        meta: {
          ...get().meta,
          timestampedNotes: {
            ...get().meta.timestampedNotes,
            [get().getCurrentTime()]: note,
          },
        },
      });
    },
    addScreenshot: (url: string) => {
      set({
        meta: {
          ...get().meta,
          screenshots: {
            ...get().meta.screenshots,
            [get().getCurrentTime()]: url,
          },
        },
      });
    },
  };
});

const unpackMediaRecorder = async (
  recorder: MediaRecorder | null,
  type = "audio/webm",
) => {
  if (!recorder) return Promise.resolve(null);
  return new Promise<Buffer>((r) => {
    recorder.stop();
    // eslint-disable-next-line no-param-reassign
    recorder.ondataavailable = async (e) => {
      const blob = new Blob([e.data], { type });
      r(await blobToBuffer(blob));
    };
  });
};

const unpackMicTracks = async (
  tracks: MicTrack[] | undefined,
  type = "audio/webm",
): Promise<CapturedMicTrack[]> => {
  if (!tracks || tracks.length === 0) return [];
  // Run unpacks in parallel — each track has its own MediaRecorder so they
  // produce blobs independently. Order doesn't matter here; we tag the
  // primary explicitly via `isPrimary`.
  return Promise.all(
    tracks.map(
      (track) =>
        new Promise<CapturedMicTrack>((resolve) => {
          track.recorder.stop();
          // eslint-disable-next-line no-param-reassign
          track.recorder.ondataavailable = async (e) => {
            const blob = new Blob([e.data], { type });
            const buffer = await blobToBuffer(blob);
            resolve({
              data: buffer,
              isPrimary: track.isPrimary,
              kind: track.kind,
              label: track.label,
              deviceId: track.deviceId,
            });
          };
        }),
    ),
  );
};

export const useStopRecording = () => {
  const { recorder, meta, reset } = useRecorderState();
  return useCallback(async () => {
    if (!recorder || !meta) return;

    reset();
    const screenBuffer = await unpackMediaRecorder(recorder.screen);
    const micTracks = await unpackMicTracks(recorder.mic);
    const primary = micTracks.find((t) => t.isPrimary) ?? null;
    const additional = micTracks.filter((t) => !t.isPrimary);
    await historyApi.saveRecording({
      mic: primary?.data ?? null,
      additionalMicTracks: additional,
      screen: screenBuffer,
      meta,
    });
  }, [meta, recorder, reset]);
};

export const useMakeScreenshot = () => {
  const { recorder, addScreenshot } = useRecorderState();
  return useCallback(async () => {
    if (!recorder?.screen) return;
    const videoStream = recorder.screen.stream.getVideoTracks()[0];
    const imageCapturer = new ImageCapture(videoStream);

    const frame = await imageCapturer.grabFrame();
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext("bitmaprenderer");
    if (!ctx) throw new Error("no bitmaprenderer");
    ctx.transferFromImageBitmap(frame);
    const blob = await new Promise<Blob | null>((r) => {
      canvas.toBlob(r);
    });
    canvas.remove();
    if (!blob) throw new Error("no blob");

    /* const blob = await imageCapturer.takePhoto({
      imageWidth: videoStream.getSettings().width,
      imageHeight: videoStream.getSettings().height,
    }); */

    const buffer = await blobToBuffer(blob);
    const fileName = `${new Date().getTime()}.png`;
    await historyApi.storeUnassociatedScreenshot(fileName, buffer);
    addScreenshot(fileName);
  }, [addScreenshot, recorder?.screen]);
};

export const useMakeRegionScreenshot = () => {
  const { addScreenshot } = useRecorderState();
  return useCallback(async () => {
    const area = await mainApi.requestScreenshotArea();
    if (!area) return;

    // @ts-ignore
    const displayMedia = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // @ts-ignore
        mandatory: {
          chromeMediaSource: "screen",
          chromeMediaSourceId: area.displayId,
          minWidth: 1280,
          minHeight: 720,
          maxFrameRate: 1,
        },
      },
    });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const video = document.createElement("video");

    if (!ctx) throw new Error("no 2d context");

    video.srcObject = displayMedia;
    canvas.width = area.width;
    canvas.height = area.height;
    video.play();
    await new Promise<any>((r) => {
      video.requestVideoFrameCallback(r);
    });

    ctx.drawImage(
      video,
      area.x,
      area.y,
      area.width,
      area.height,
      0,
      0,
      area.width,
      area.height,
    );
    const blob = await new Promise<Blob | null>((r) => {
      canvas.toBlob(r);
    });
    canvas.remove();
    video.remove();
    displayMedia.getTracks().forEach((t) => t.stop());
    if (!blob) throw new Error("no blob");

    const buffer = await blobToBuffer(blob);
    const fileName = `${new Date().getTime()}.png`;
    await historyApi.storeUnassociatedScreenshot(fileName, buffer);
    addScreenshot(fileName);
  }, [addScreenshot]);
};
