import path from "path";
import fs from "fs-extra";
import * as ffmpeg from "./ffmpeg";
import * as history from "./history";
import * as whisperx from "./whisperx";
import * as models from "./models";
import * as runner from "./runner";
import * as llm from "./llm";
import * as datahooks from "./datahooks";
import { getRecordingTranscript, getRecordingsFolder } from "./history";
import { invalidateUiKeys } from "../ipc/invalidate-ui";
import { QueryKeys } from "../../query-keys";
import * as searchIndex from "./search";
import { getSettings } from "./settings";
import { PostProcessingJob, PostProcessingStep, TranscriptVersion } from "../../types";

let isRunning = false;
let processingQueue: PostProcessingJob[] = [];
let jobIdCounter = 0;
const nextJobId = (recordingId: string) =>
  `${recordingId}-${Date.now()}-${(jobIdCounter += 1)}`;
const nextOrder = () =>
  processingQueue.length === 0
    ? 0
    : Math.max(...processingQueue.map((j) => j.order)) + 1;
const sortQueue = () => {
  processingQueue = [...processingQueue].sort((a, b) => a.order - b.order);
};
const emptyProgress: Record<PostProcessingStep, null | number> = {
  modelDownload: 0,
  wav: null,
  mp3: null,
  whisper: 0,
  summary: 0,
  datahooks: null,
};
const progress = { ...emptyProgress };
let lastUiUpdate = 0;
let currentStep: keyof typeof progress | "notstarted" = "notstarted";
let abortedFlag = false;
let cancelCurrentFlag = false;

export const hasAborted = () => abortedFlag;
export const hasCancelledCurrent = () => cancelCurrentFlag;

const updateUiProgress = () => {
  if (Date.now() < lastUiUpdate) {
    return;
  }

  if (Date.now() - lastUiUpdate > 100) {
    lastUiUpdate = Date.now();
    invalidateUiKeys(QueryKeys.PostProcessing);
    return;
  }

  setTimeout(() => {
    invalidateUiKeys(QueryKeys.PostProcessing);
  }, 100);
  lastUiUpdate = Date.now() + 100;
};

export const getCurrentItem = () => {
  if (!isRunning) return null;
  return (
    processingQueue.find((j) => j.status === "processing") ??
    processingQueue[0] ??
    null
  );
};

export const getProgress = (step: keyof typeof progress) => {
  return progress[step];
};

export const setProgress = (step: keyof typeof progress, value: number) => {
  progress[step] = value;
  updateUiProgress();
};

export const setStep = (step: keyof typeof progress | "notstarted") => {
  currentStep = step;
  updateUiProgress();
};

export const addToQueue = (
  job: Omit<PostProcessingJob, "status" | "order" | "id"> & {
    id?: string;
    status?: PostProcessingJob["status"];
    order?: number;
  },
) => {
  const full: PostProcessingJob = {
    ...job,
    id: job.id ?? nextJobId(job.recordingId),
    status: job.status ?? "queued",
    order: job.order ?? nextOrder(),
  };
  processingQueue.push(full);
  sortQueue();
  updateUiProgress();
};

export const cancelCurrentItem = () => {
  cancelCurrentFlag = true;
  runner.abortAllExecutions();
};

export const removeFromQueue = (id: string) => {
  const job = processingQueue.find((j) => j.id === id);
  if (!job) return;
  if (job.status === "processing") {
    cancelCurrentItem();
    // The runner will mark it cancelled and advance; we leave the entry
    // visible so the user can retry, mirroring the failed-state behaviour.
    return;
  }
  processingQueue = processingQueue.filter((j) => j.id !== id);
  updateUiProgress();
};

export const retryItem = (id: string) => {
  const job = processingQueue.find((j) => j.id === id);
  if (!job) return;
  if (job.status !== "failed" && job.status !== "cancelled") return;
  job.status = "queued";
  job.error = undefined;
  job.order = nextOrder();
  sortQueue();
  if (!isRunning) startQueue();
  updateUiProgress();
};

export const reorderItem = (id: string, afterId: string | null) => {
  const sorted = [...processingQueue].sort((a, b) => a.order - b.order);
  const fromIdx = sorted.findIndex((j) => j.id === id);
  if (fromIdx === -1) return;
  const job = sorted[fromIdx];
  if (job.status !== "queued") return;
  const [removed] = sorted.splice(fromIdx, 1);
  let toIdx: number;
  if (afterId === null) {
    toIdx = 0;
  } else {
    const afterIdx = sorted.findIndex((j) => j.id === afterId);
    toIdx = afterIdx === -1 ? sorted.length : afterIdx + 1;
  }
  sorted.splice(toIdx, 0, removed);
  sorted.forEach((j, i) => {
    j.order = i;
  });
  processingQueue = sorted;
  updateUiProgress();
};

export const retryAllFailed = () => {
  const candidates = processingQueue.filter(
    (j) => j.status === "failed" || j.status === "cancelled",
  );
  if (candidates.length === 0) return;
  let order = nextOrder();
  for (const job of candidates) {
    job.status = "queued";
    job.error = undefined;
    job.order = order;
    order += 1;
  }
  sortQueue();
  if (!isRunning) startQueue();
  updateUiProgress();
};

export const clearCompleted = () => {
  processingQueue = processingQueue.filter((j) => j.status !== "done");
  updateUiProgress();
};

const getFilePaths = async (job: PostProcessingJob) => {
  const recordingsFolder = await getRecordingsFolder();
  const recordingFolder = path.join(recordingsFolder, job.recordingId);
  const mic = path.join(recordingFolder, "mic.webm");
  const screen = path.join(recordingFolder, "screen.webm");
  const wav = path.join(recordingFolder, "whisper-input.wav");
  const mp3 = path.join(recordingFolder, "recording.mp3");
  const mergedMic = path.join(recordingFolder, "mic-merged.webm");
  return {
    mic,
    screen,
    wav,
    mp3,
    mergedMic,
    recordingFolder,
    recordingsFolder,
  };
};

/**
 * Resolve the on-disk paths of every additional mic file for this
 * recording. Reads the recording meta to get the authoritative list — the
 * folder may also contain stale files from prior runs (e.g. a re-run after
 * deletion), so we trust meta over the directory listing.
 */
const getAdditionalMicPaths = async (
  job: PostProcessingJob,
): Promise<string[]> => {
  const meta = await history
    .getRecordingMeta(job.recordingId)
    .catch(() => null);
  if (!meta?.additionalMicFiles?.length) return [];
  const { recordingFolder } = await getFilePaths(job);
  return meta.additionalMicFiles
    .map((f) => path.join(recordingFolder, f.fileName))
    .filter((p) => fs.existsSync(p));
};

/**
 * Pick the mic input for downstream wav/mp3 steps. When the recording has
 * additional per-device tracks we merge them with the primary mic into a
 * single `mic-merged.webm` first so WhisperX gets one coherent track. The
 * individual files stay on disk untouched.
 *
 * Returns `null` when there is no mic input at all (screen-only).
 */
const getMergedMicPath = async (
  job: PostProcessingJob,
): Promise<string | null> => {
  const { mic, mergedMic } = await getFilePaths(job);
  const additional = await getAdditionalMicPaths(job);
  const inputs = [...(fs.existsSync(mic) ? [mic] : []), ...additional];
  if (inputs.length === 0) return null;
  if (inputs.length === 1) return inputs[0];
  if (fs.existsSync(mergedMic)) return mergedMic;
  await ffmpeg.mergeAudioTracks(inputs, mergedMic);
  return mergedMic;
};

const hasStep = (job: PostProcessingJob, step: PostProcessingStep) => {
  return !job.steps || job.steps?.includes(step);
};

const isCancelMidProcessing = (job: PostProcessingJob) =>
  cancelCurrentFlag && job.status === "processing";

const doWavStep = async (job: PostProcessingJob) => {
  if (hasAborted() || isCancelMidProcessing(job) || !hasStep(job, "wav"))
    return;
  setStep("wav");
  const { screen, wav } = await getFilePaths(job);
  const mergedMic = await getMergedMicPath(job);

  if (mergedMic && fs.existsSync(screen)) {
    await ffmpeg.toStereoWavFile(mergedMic, screen, wav);
  } else if (mergedMic) {
    await ffmpeg.toWavFile(mergedMic, wav);
  } else if (fs.existsSync(screen)) {
    await ffmpeg.toWavFile(screen, wav);
  } else {
    // No recording files, skipping step
  }
};

const doMp3Step = async (job: PostProcessingJob) => {
  if (hasAborted() || isCancelMidProcessing(job) || !hasStep(job, "mp3"))
    return;
  setStep("mp3");
  const { screen, mp3 } = await getFilePaths(job);
  const mergedMic = await getMergedMicPath(job);

  if (mergedMic && fs.existsSync(screen)) {
    await ffmpeg.toJoinedFile(mergedMic, screen, mp3);
  } else if (mergedMic) {
    await ffmpeg.toJoinedFile(mergedMic, null, mp3);
  } else if (fs.existsSync(screen)) {
    await ffmpeg.toJoinedFile(screen, null, mp3);
  } else {
    // No recording files, skipping step
  }
};

const doWhisperStep = async (job: PostProcessingJob) => {
  if (hasAborted() || isCancelMidProcessing(job) || !hasStep(job, "whisper"))
    return;
  const { wav, mp3, recordingsFolder } = await getFilePaths(job);

  const whisperOpts = job.whisperOptions;
  const saveAsVersion = whisperOpts?.saveAsVersion ?? false;
  const modelOverride = whisperOpts?.modelOverride;

  // When re-processing with a model override, use that directly; otherwise
  // prepare the configured model as usual.
  const model: string = modelOverride ?? (await models.prepareConfiguredModel());

  // For versioned saves, write to a temp path then promote; for normal
  // runs write straight to transcript.json.
  const transcriptPath = saveAsVersion
    ? path.join(recordingsFolder, job.recordingId, `transcript-reprocess-tmp.json`)
    : path.join(recordingsFolder, job.recordingId, "transcript.json");

  try {
    const { segments } = await whisperx.processWavFile(
      wav,
      transcriptPath,
      model,
    );

    if (saveAsVersion) {
      // Read back the written transcript and save as a versioned batch entry
      try {
        const raw = await fs.readJson(transcriptPath) as import("../../types").RecordingTranscript;
        const versionId = `batch-${Date.now()}`;
        const version: TranscriptVersion = {
          id: versionId,
          kind: "batch",
          model: modelOverride ?? model,
          createdAt: new Date().toISOString(),
          items: raw.transcription,
          status: "done",
          language: raw.result?.language,
        };
        await history.saveTranscriptVersion(job.recordingId, version);
        await history.setActiveTranscriptVersion(job.recordingId, versionId);
      } finally {
        // Clean up the temporary transcript file
        await fs.rm(transcriptPath, { force: true }).catch(() => {});
      }
    }

    // Run the speaker embedding + profile-matching pipeline. We prefer the
    // 16kHz mono/stereo wav we just transcribed against: soundfile/libsndfile
    // reads it directly without shelling out to ffmpeg, which matters on
    // Windows where the bundled ffmpeg isn't on PATH for the sidecar's
    // librosa/audioread fallback. The mp3 is only used if the wav is already
    // gone (post-processing re-entry).
    if (!saveAsVersion) {
      try {
        const audioForEmbedding = fs.existsSync(wav) ? wav : mp3;
        if (fs.existsSync(audioForEmbedding) && segments.length > 0) {
          const embed = await whisperx.runSpeakerEmbeddingPipeline({
            recordingId: job.recordingId,
            audioPath: audioForEmbedding,
            segments,
          });
          // Merge into meta so the UI can see matches/errors without re-running.
          await history.updateRecording(job.recordingId, {
            speakerEmbeddings: embed.speakerEmbeddings,
            speakerMatches: embed.speakerMatches,
            speakerNames: embed.speakerNames,
            pipelineError: embed.pipelineError ?? null,
          });
        }
      } catch (e) {
        // Last-ditch: never let embeddings crash the whisper step.
        const message = e instanceof Error ? e.message : String(e);
        await history.updateRecording(job.recordingId, {
          pipelineError: { stage: "embed", message },
        });
      }
    }
  } finally {
    // Always drop the intermediate wav, even if transcription or the
    // embedding step threw. Leaving it behind wastes disk and confuses
    // re-runs. `fs.rm` tolerates a missing path (force: true).
    if (fs.existsSync(wav)) {
      await fs.rm(wav, { force: true }).catch(() => {});
    }
  }
};

const doSummaryStep = async (job: PostProcessingJob) => {
  const settings = await getSettings();
  const transcript = await getRecordingTranscript(job.recordingId);

  if (
    hasAborted() ||
    isCancelMidProcessing(job) ||
    !hasStep(job, "summary") ||
    !settings.llm.enabled ||
    !transcript
  )
    return;
  setStep("summary");

  const summary = await llm.summarize(transcript);
  await history.updateRecording(job.recordingId, { summary });
};

const doDataHooksStep = async (job: PostProcessingJob) => {
  const settings = await getSettings();

  if (
    hasAborted() ||
    isCancelMidProcessing(job) ||
    !hasStep(job, "datahooks") ||
    !settings.datahooks.enabled
  )
    return;
  setStep("datahooks");
  await datahooks.runDatahooks(job);
};

const postProcessRecording = async (job: PostProcessingJob) => {
  await doWavStep(job);
  await doMp3Step(job);
  await doWhisperStep(job);
  await doSummaryStep(job);
  await doDataHooksStep(job);

  const settings = await getSettings();

  const { mic, screen, mergedMic } = await getFilePaths(job);
  const additional = await getAdditionalMicPaths(job);
  if (settings.ffmpeg.removeRawRecordings) {
    if (fs.existsSync(mic)) {
      await fs.rm(mic);
    }
    if (fs.existsSync(screen)) {
      await fs.rm(screen);
    }
    for (const p of additional) {
      if (fs.existsSync(p)) {
        // eslint-disable-next-line no-await-in-loop
        await fs.rm(p);
      }
    }
    await history.updateRecording(job.recordingId, { hasRawRecording: false });
  }
  // The merged mic file is always intermediate — it's only ever used to
  // feed the wav/mp3 steps and isn't part of the on-disk archive.
  if (fs.existsSync(mergedMic)) {
    await fs.rm(mergedMic).catch(() => {});
  }

  const transcript = await getRecordingTranscript(job.recordingId);
  await history.updateRecording(job.recordingId, {
    isPostProcessed: true,
    language: transcript?.result.language,
  });
  searchIndex.addRecordingToIndex(job.recordingId);
  updateUiProgress();
};

const resetProgress = () => {
  progress.modelDownload = 0;
  progress.wav = 0;
  progress.mp3 = 0;
  progress.whisper = 0;
  progress.summary = 0;
};

export const startQueue = () => {
  if (isRunning) {
    return;
  }

  abortedFlag = false;
  isRunning = true;
  const next = async () => {
    const job = processingQueue
      .filter((j) => j.status === "queued")
      .sort((a, b) => a.order - b.order)[0];

    if (!job) {
      isRunning = false;
      updateUiProgress();
      return;
    }

    cancelCurrentFlag = false;
    try {
      job.status = "processing";
      resetProgress();
      updateUiProgress();
      await postProcessRecording(job);
      job.status = cancelCurrentFlag ? "cancelled" : "done";
    } catch (err) {
      if (hasAborted()) {
        // Whole-queue stop: leave job as-is (still 'processing' visually).
        // We reset on next start.
        return;
      }
      console.error("Failed to process recording", job.recordingId, err);
      job.error = err instanceof Error ? err.message : String(err);
      job.status = cancelCurrentFlag ? "cancelled" : "failed";
    } finally {
      cancelCurrentFlag = false;
    }
    updateUiProgress();
    next();
  };

  next();
};

export const stop = () => {
  abortedFlag = true;
  runner.abortAllExecutions();
  isRunning = false;
  // Reset any in-flight item back to queued so the user can resume.
  processingQueue.forEach((j) => {
    if (j.status === "processing") j.status = "queued";
  });
  resetProgress();
  setStep("notstarted");
  updateUiProgress();
};

export const clearList = () => {
  processingQueue = [];
  updateUiProgress();
};

export const getProgressData = () => {
  return {
    progress,
    processingQueue,
    isRunning,
    currentStep,
  };
};
