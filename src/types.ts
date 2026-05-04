import { app } from "electron";
import path from "path";
import { datahookMarkdownTemplate } from "./datahooks-defaults";

export type RecordingConfig = {
  recordScreenAudio?: boolean;
  mic?: MediaDeviceInfo;
};

export type RecordingData = {
  mic?: ArrayBuffer | null;
  screen?: ArrayBuffer | null;
  meta: RecordingMeta;
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

export type PostProcessingJob = {
  recordingId: string;
  steps?: PostProcessingStep[];
  error?: string;
  isDone?: boolean;
  isRunning?: boolean;
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
    executable: "whisperx",
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
      matchThreshold: 0.75,
      minSpeakerSeconds: 0.3,
    },
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
