import { RecordingConfig } from "../../types";

export type AudioChunkCallback = (chunk: Buffer) => void;

const createScreenRecorder = async () => {
  // @ts-ignore
  const displayMedia = await navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-ignore
      mandatory: {
        chromeMediaSource: "desktop",
        sampleRate: 48000,
        sampleSize: 16,
        channelCount: 2,
      },
    },
    video: {
      // @ts-ignore
      mandatory: {
        chromeMediaSource: "desktop",
        minWidth: 1280,
        maxWidth: 1280,
        minHeight: 720,
        maxHeight: 720,
        maxFrameRate: 1,
      },
    },
  });
  displayMedia.getVideoTracks().forEach((t) => displayMedia.removeTrack(t));
  const screen = new MediaRecorder(displayMedia, {
    mimeType: "audio/webm",
    videoBitsPerSecond: 0,
  });
  screen.start();
  return screen;
};

/**
 * Per-device captured track. Each entry owns its own `MediaRecorder` so the
 * raw audio for that device lands on disk untouched. Post-processing merges
 * the resulting files into a single mix for WhisperX.
 */
export type MicTrack = {
  recorder: MediaRecorder;
  isPrimary: boolean;
  kind: "input" | "output";
  label: string;
  deviceId: string;
};

const captureStream = async (
  device: MediaDeviceInfo,
  isOutput: boolean,
): Promise<MediaStream | null> => {
  try {
    // Audio outputs are not officially capturable via getUserMedia, but on
    // Windows, virtual mix devices like SteelSeries Sonar's Gaming/Chat/
    // Media channels are often exposed as accessible inputs even when
    // enumerated as `audiooutput`. We attempt the same constraint either
    // way and skip on failure rather than crashing the whole recording.
    // True loopback capture of plain output devices requires WASAPI and
    // is a known limitation.
    return await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: device.deviceId } },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `Failed to capture ${isOutput ? "output" : "input"} device ${
        device.label || device.deviceId
      }, skipping:`,
      err,
    );
    return null;
  }
};

const createMicRecorder = async (
  config: RecordingConfig,
  onAudioChunk?: AudioChunkCallback,
): Promise<MicTrack[]> => {
  const additional = config.additionalAudioDevices ?? [];

  // Build the full target list. The primary is always treated as an input
  // even if the underlying device kind disagrees; additional devices keep
  // whatever kind the user picked. When no primary mic is configured we
  // still proceed so additional devices can capture.
  type Target = { device: MediaDeviceInfo; isPrimary: boolean };
  const targets: Target[] = [
    ...(config.mic ? [{ device: config.mic, isPrimary: true }] : []),
    ...additional.map((d) => ({ device: d, isPrimary: false })),
  ];

  const tracks: MicTrack[] = [];
  for (const target of targets) {
    const isOutput = !target.isPrimary && target.device.kind === "audiooutput";
    // eslint-disable-next-line no-await-in-loop
    const stream = await captureStream(target.device, isOutput);
    if (!stream) {
      // Skip unusable devices; continue attempting the rest.
      // eslint-disable-next-line no-continue
      continue;
    }
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    // If this is the primary mic and a live-transcription callback is provided,
    // start with 250ms timeslicing so we get data chunks during recording.
    if (target.isPrimary && onAudioChunk) {
      recorder.start(250); // timeslice: fire dataavailable every 250ms
      recorder.addEventListener("dataavailable", (e) => {
        if (e.data && e.data.size > 0) {
          e.data.arrayBuffer().then((ab) => {
            onAudioChunk(Buffer.from(ab));
          });
        }
      });
    } else {
      recorder.start();
    }
    tracks.push({
      recorder,
      isPrimary: target.isPrimary,
      kind: isOutput ? "output" : "input",
      label: target.device.label,
      deviceId: target.device.deviceId,
    });
  }

  // If a primary mic was configured but failed to capture, log a warning
  // and continue — additional devices may have succeeded.
  if (config.mic && !tracks.some((t) => t.isPrimary)) {
    // eslint-disable-next-line no-console
    console.warn(
      "Primary mic failed to capture; continuing with additional devices only.",
    );
  }

  // Nothing captured at all — stop any stray recorders and signal no audio.
  if (tracks.length === 0) {
    tracks.forEach((t) => {
      try {
        t.recorder.stop();
        t.recorder.stream.getTracks().forEach((s) => s.stop());
      } catch {
        // best-effort cleanup
      }
    });
    return [];
  }

  return tracks;
};

export const createRecorder = async (
  config: RecordingConfig,
  onAudioChunk?: AudioChunkCallback,
) => {
  const screen = await createScreenRecorder();
  const mic = await createMicRecorder(config, onAudioChunk);
  return { screen, mic };
};
