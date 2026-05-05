import Handlebars from "handlebars";
import path from "path";
import fsExtra from "fs-extra";
import { execaCommand } from "execa";
import * as os from "node:os";
import log from "electron-log/main";
import { PostProcessingJob } from "../../types";
import { getSettings } from "./settings";
import * as history from "./history";
import {
  loadProfilesById,
  resolveSpeakerDisplayName,
} from "./speaker-profiles";

let relativeBase: string | undefined;

Handlebars.registerHelper("relative", (value: string) =>
  relativeBase ? path.relative(path.dirname(relativeBase), value) : value,
);
Handlebars.registerHelper("pathsafe", (value: string) =>
  value?.replace(/[^a-z0-9]/gi, "_"),
);
Handlebars.registerHelper("localeDateTime", (value: string) =>
  new Date(value).toLocaleString(),
);
Handlebars.registerHelper("localeDate", (value: string) =>
  new Date(value).toLocaleDateString(),
);
Handlebars.registerHelper("localeTime", (value: string) =>
  new Date(value).toLocaleTimeString(),
);
Handlebars.registerHelper(
  "keydate",
  (value: string) => new Date(value).toISOString().split("T")[0],
);
Handlebars.registerHelper("year", (value: string) =>
  new Date(value).getFullYear(),
);
Handlebars.registerHelper("month", (value: string) =>
  new Date(value).getMonth(),
);
Handlebars.registerHelper("day", (value: string) => new Date(value).getDate());
Handlebars.registerHelper(
  "ifEquals",
  function Handler(this: any, arg1, arg2, options) {
    return arg1 === arg2 ? options.fn(this) : options.inverse(this);
  },
);
Handlebars.registerHelper(
  "ifNotEquals",
  function Handler(this: any, arg1, arg2, options) {
    return arg1 !== arg2 ? options.fn(this) : options.inverse(this);
  },
);

const evaluate = (value: string, params: any) => {
  return Handlebars.compile(value)(params);
};

const getAssetParams = (id: string, fileName: string) => ({
  id,
  timestamp: id,
  fileName,
  ext: path.extname(fileName),
  baseName: path.basename(fileName, path.extname(fileName)),
});

export const runDatahooks = async (job: PostProcessingJob) => {
  const settings = await getSettings();
  const transcript = await history.getRecordingTranscript(job.recordingId);
  const recording = await history.getRecordingMeta(job.recordingId);

  // Build a speaker key -> display name map using the shared resolver.
  const profilesById = await loadProfilesById();
  const speakerKeys = [
    ...new Set(
      (transcript?.transcription ?? []).map((t) => t.speaker).filter(Boolean),
    ),
  ];
  const speakersMap = Object.fromEntries(
    speakerKeys.map((k) => [
      k,
      resolveSpeakerDisplayName(k, recording, profilesById),
    ]),
  );

  // Register a convenient Handlebars helper so templates can write
  // {{speakerName speaker}} instead of {{lookup speakersMap speaker}}.
  Handlebars.registerHelper("speakerName", (key: string) => speakersMap[key] ?? key);

  const globalParams = {
    ...recording,
    // Augment each transcript item with a resolved speakerName field while
    // keeping the raw speaker key intact for backwards compatibility.
    transcript: transcript?.transcription.map((t, i) => ({
      ...t,
      speakerName: resolveSpeakerDisplayName(t.speaker, recording, profilesById, i),
    })),
    speakersMap,
    date: recording.started,
    homedir: os.userInfo().homedir,
  } as any;
  const assets: string[] = [];

  log.info("Datahooks using parameters", globalParams);

  const mp3 = path.join(
    await history.getRecordingsFolder(),
    job.recordingId,
    "recording.mp3",
  );
  if (settings.datahooks.features.exportMp3 && fsExtra.existsSync(mp3)) {
    const target = evaluate(settings.datahooks.mp3Path, globalParams);
    await fsExtra.ensureDir(path.dirname(target));
    await fsExtra.copy(mp3, target);
    globalParams.mp3Path = target;
  }

  if (settings.datahooks.features.exportAssets && recording.screenshots) {
    for (const [id, screenshot] of Object.entries(recording.screenshots)) {
      const target = evaluate(settings.datahooks.assetPath, {
        ...globalParams,
        ...getAssetParams(id, screenshot),
      });
      assets.push(target);
      await fsExtra.copy(
        path.join(
          await history.getRecordingsFolder(),
          job.recordingId,
          screenshot,
        ),
        target,
      );
    }
    globalParams.assets = assets.map((file) => ({ file }));
  }

  if (settings.datahooks.features.exportMarkdown) {
    const target = evaluate(settings.datahooks.markdownPath, globalParams);
    relativeBase = target;
    await fsExtra.ensureDir(path.dirname(target));
    await fsExtra.writeFile(
      target,
      evaluate(settings.datahooks.markdownTemplate, globalParams),
    );
  }

  if (settings.datahooks.features.exportJson) {
    const target = evaluate(settings.datahooks.jsonPath, globalParams);
    relativeBase = target;
    await fsExtra.ensureDir(path.dirname(target));
    await fsExtra.writeJSON(target, globalParams);
  }

  if (settings.datahooks.callCmdlet) {
    const cmd = evaluate(settings.datahooks.callCmdlet, globalParams);
    await execaCommand(cmd, {});
  }
};
