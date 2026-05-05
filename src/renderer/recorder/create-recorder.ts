import { RecordingConfig } from "../../types";

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

const createMicRecorder = async (config: RecordingConfig) => {
  if (!config.mic) return null;

  const additional = config.additionalAudioDevices ?? [];
  // Build the full target list. Primary is always an audio input; additional
  // devices may be input or output.
  const targets: { device: MediaDeviceInfo; isOutput: boolean }[] = [
    { device: config.mic, isOutput: false },
    ...additional.map((d) => ({
      device: d,
      isOutput: d.kind === "audiooutput",
    })),
  ];

  const captureStream = async (target: {
    device: MediaDeviceInfo;
    isOutput: boolean;
  }): Promise<MediaStream | null> => {
    try {
      // Audio outputs are not officially capturable via getUserMedia, but on
      // Windows, virtual mix devices like SteelSeries Sonar's Gaming/Chat/
      // Media channels are often exposed as accessible inputs even when
      // enumerated as `audiooutput`. We attempt the same constraint either
      // way and skip on failure rather than crashing the whole recording.
      // True loopback capture of plain output devices requires WASAPI and
      // is a known limitation.
      return await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: target.device.deviceId } },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `Failed to capture ${target.isOutput ? "output" : "input"} device ${
          target.device.label || target.device.deviceId
        }, skipping:`,
        err,
      );
      return null;
    }
  };

  // Single-device path: keep the simple, original pipeline.
  if (targets.length === 1) {
    const stream = await captureStream(targets[0]);
    if (!stream) return null;
    const mic = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mic.start();
    return mic;
  }

  // Multi-device path: capture each, mix via Web Audio API.
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const captured = await Promise.all(targets.map(captureStream));
  let attached = 0;
  captured.forEach((stream) => {
    if (!stream) return;
    const source = ctx.createMediaStreamSource(stream);
    source.connect(dest);
    attached += 1;
  });

  if (attached === 0) {
    // Nothing usable captured — close the context and bail out so we don't
    // record silence.
    await ctx.close().catch(() => {});
    return null;
  }

  const mic = new MediaRecorder(dest.stream, { mimeType: "audio/webm" });
  mic.start();
  return mic;
};

export const createRecorder = async (config: RecordingConfig) => {
  const screen = await createScreenRecorder();
  const mic = await createMicRecorder(config);
  return { screen, mic };
};
