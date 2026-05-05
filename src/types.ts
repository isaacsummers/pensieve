import { app } from "electron";
import path from "path";
import { datahookMarkdownTemplate } from "./datahooks-defaults";

export type RecordingConfig = {
  recordScreenAudio?: boolean;
  /** Primary microphone input (kept for backwards compatibility). */
  mic?: MediaDeviceInfo;
  /**
   * Additional audio devices to capture alongside the primary mic. May
   * include both `audioinput` and `audiooutput` kinds — output devices are
   * supported best-effort for things like SteelSeries Sonar's virtual
   * channels, which often expose accessible inputs on Windows. True
   * loopback capture of plain output devices requires WASAPI and is a
   * known limitation handled gracefully at record time.
   */
  additionalAudioDevices?: MediaDeviceInfo[];
};

/**
 * One captured audio device. The primary mic is the one selected as the
 * "main" input; any additional inputs/outputs (e.g. SteelSeries Sonar's
 * Gaming/Chat/Media virtual outputs) ride alongside it as separate
 * recorders so each track can be reviewed individually on disk.
 */
export type CapturedMicTrack = {
  data: ArrayBuffer;
  /** True for the user-selected primary microphone. */
  isPrimary: boolean;
  /** The device's enumerated kind. Outputs are best-effort captures. */
  kind: "input" | "output";
  /** Original device label as reported by `navigator.mediaDevices`. */
  label: string;
  /** Persistent device id (may rotate across sessions). */
  deviceId: string;
};

export type RecordingData = {
  /** Primary mic buffer. Kept for backwards compatibility. */
  mic?: ArrayBuffer | null;
  /**
   * Additional captured audio tracks (extra inputs and best-effort outputs)
   * saved next to the primary mic. Each is written as its own file so the
   * raw per-device audio is preserved; post-processing merges them all
   * into a single mix for transcription.
   */
  additionalMicTracks?: CapturedMicTrack[];
  screen?: ArrayBuffer | null;
  meta: RecordingMeta;
};

/**
 * On-disk record of an additional mic track captured alongside the primary
 * `mic.webm`. Stored on `RecordingMeta` so the post-processing pipeline can
 * locate every track when building the merged transcription input.
 */
export type AdditionalMicFile = {
  /** File name relative to the recording folder (e.g. `mic-headset.webm`). */
  fileName: string;
  /** Original device label. */
  label: string;
  /** Original device id at recording time. */
  deviceId: string;
  /** Whether the device was an audio input or audio output. */
  kind: "input" | "output";
};

export type RecordingMeta = {
  started: string;
  duration?: number;
  name?: string;
  isPostProcessed?: boolean;
  isImported?: boolean;
  hasRawRecording?: boolean;
  hasMic?: boolean;
  hasScreen?: boolean;
  /**
   * Per-device audio tracks captured alongside the primary mic. Empty or
   * missing for single-device recordings. Used by the post-processing
   * merge step to gather every track for WhisperX.
   */
  additionalMicFiles?: AdditionalMicFile[];
  language?: string;
  notes?: string;
  timestampedNotes?: Record<number, string>;
  highlights?: number[];
  screenshots?: Record<number, string>;
  summary?: {
    summary?: string | null;
    actionItems?: { isMe: boolean; action: string; time: number }[] | null;
    sentenceSummary?: string | null;
  };
  isPinned?: boolean;
  /**
   * Per-recording overrides for the display name of a diarization speaker
   * key (the normalized label stored on transcript items, e.g. "0", "1").
   * Empty/missing => show the default `Speaker N` label.
   */
  speakerNames?: Record<string, string>;
  /** Auto-match info produced by the embedding pipeline, per speaker key. */
  speakerMatches?: Record<
    string,
    {
      profileId: string | null;
      profileName: string | null;
      confidence: number;
      matched: boolean;
    }
  >;
  /** Raw per-speaker embedding vectors from the last diarization pass. */
  speakerEmbeddings?: Record<string, number[]>;
  /**
   * Per-recording sticky rejections: speakerKey → array of profileIds the user
   * explicitly dismissed for this recording. Prevents re-surfacing the pill.
   */
  rejectedSuggestions?: Record<string, string[]>;
  /** Most recent non-fatal pipeline error surfaced on this recording. */
  pipelineError?: { stage: string; message: string } | null;
};

export type SpeakerProfile = {
  id: string;
  name: string;
  embedding: number[];
  createdAt: string;
  updatedAt: string;
  sampleCount: number;
};

export type RecordingTranscript = {
  result: { language: string };
  transcription: RecordingTranscriptItem[];
};

export type RecordingTranscriptItem = {
  timestamps: { from: string; to: string };
  offsets: { from: number; to: number };
  text: string;
  speaker: string;
};

export type PostProcessingStep =
  | "modelDownload"
  | "wav"
  | "mp3"
  | "whisper"
  | "summary"
  | "datahooks";

export type QueueItemStatus =
  | "queued"
  | "processing"
  | "failed"
  | "done"
  | "cancelled";

export type PostProcessingJob = {
  /** Stable id for renderer keys and IPC addressing. */
  id: string;
  recordingId: string;
  steps?: PostProcessingStep[];
  status: QueueItemStatus;
  error?: string;
  /** Sort key — authoritative ordering for the queue. */
  order: number;
};

export type PersistedAudioDevice = {
  deviceId: string;
  kind: "input" | "output";
};

export const defaultSettings = {
  core: { recordingsFolder: path.join(app.getPath("userData"), "recordings") },
  ui: {
    dark: true,
    autoStart: true,
    trayRunningNotificationShown: false,
    useOverlayTool: true,
  },
  llm: {
    enabled: true,
    prompt: "",
    features: {
      summary: true,
      actionItems: true,
      sentenceSummary: true,
    },
    useEmbedding: true,
    provider: "ollama" as "ollama" | "openai",
    providerConfig: {
      ollama: {
        chatModel: {
          baseUrl: "http://localhost:11434",
          model: "gemma3:4b",
        },
        embeddings: {
          model: "nomic-embed-text",
          maxConcurrency: 5,
        },
      },
      openai: {
        useCustomUrl: false,
        chatModel: {
          apiKey: "YOUR_API_KEY",
          model: "gpt-3.5-turbo",
          configuration: {
            baseURL: undefined,
          },
        },
        embeddings: {
          model: "text-embedding-3-large",
          dimensions: 1536,
          batchSize: 20,
        },
      },
    },
  },
  ffmpeg: {
    removeRawRecordings: true,
    autoTriggerPostProcess: true,
    binaryPath: "",
  },
  whisperx: {
    executable: "",
    pythonPath: "",
    model: "large-v3",
    language: "auto",
    // Safe cross-platform defaults. On first run, settings init probes the
    // host for an NVIDIA toolchain (or macOS MPS) and atomically flips to
    // `cuda`/`float16` when available. CPU + int8 keeps first-run from
    // hard-crashing on machines without a compatible accelerator.
    device: "cpu" as "cuda" | "cpu" | "mps",
    computeType: "int8" as "float16" | "int8" | "float32",
    batchSize: 16,
    diarize: true,
    hfToken: "",
    minSpeakers: 0,
    maxSpeakers: 0,
    vadMethod: "silero" as "silero" | "pyannote",
    translate: false,
    alignOutput: true,
    embeddings: {
      enabled: true,
      pythonPath: "",
      scriptPath: "",
      autoConfirmThreshold: 0.80,
      suggestThreshold: 0.65,
      matchThreshold: 0.75,
      minSpeakerSeconds: 0.3,
    },
  },
  recording: {
    /** Persisted last mic-enabled state. */
    micEnabled: true,
    /** Last selected primary mic deviceId (null = system default). */
    selectedMicDeviceId: null as string | null,
    /**
     * Additional audio devices captured alongside the primary mic. May be
     * audio inputs or audio outputs (virtual mix devices like Sonar's
     * Gaming/Chat/Media channels often appear as outputs).
     */
    additionalAudioDevices: [] as {
      deviceId: string;
      kind: "input" | "output";
    }[],
  },
  datahooks: {
    enabled: false,
    features: {
      exportMarkdown: true,
      exportJson: false,
      exportMp3: true,
      exportAssets: true,
      callCmdlet: false,
    },
    markdownTemplate: datahookMarkdownTemplate,
    markdownPath:
      "{{homedir}}\\Desktop\\Pensieve Recordings\\\\{{keydate date}} - {{pathsafe name}}.md",
    jsonPath:
      "{{homedir}}\\Desktop\\Pensieve Recordings\\\\{{keydate date}}.json",
    mp3Path:
      "{{homedir}}\\Desktop\\Pensieve Recordings\\\\{{keydate date}} - {{pathsafe name}}.mp3",
    assetPath:
      "{{homedir}}\\Desktop\\Pensieve Recordings\\assets\\\\{{keydate date}}_{{timestamp}}{{ext}}",
    callCmdlet: 'echo "Recording stored to {{date}}."',
  },
};

export type Settings = typeof defaultSettings;

export type ScreenshotArea = {
  displayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RecordingIpcState = {
  meta: RecordingMeta | undefined;
  isRecording: boolean;
  isPaused: boolean;
};

export type RecordingIpcEvents = {
  addTimestampedNote: () => void;
  addHighlight: () => void;
  addScreenshot: () => void;
  setMeta: (meta: Partial<RecordingMeta>) => void;
  abort: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
};
