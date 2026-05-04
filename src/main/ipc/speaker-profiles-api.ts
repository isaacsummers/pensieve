import * as profiles from "../domain/speaker-profiles";
import * as history from "../domain/history";
import { RecordingMeta } from "../../types";

export const speakerProfilesApi = {
  list: async () => profiles.listProfiles(),

  rename: async (id: string, name: string) => profiles.renameProfile(id, name),

  remove: async (id: string) => profiles.removeProfile(id),

  getStatus: async () => profiles.getLastError(),

  testPipeline: async () => profiles.testPipeline(),

  installDeps: async () => profiles.installEmbedDeps(),

  getVenvStatus: async () => profiles.getVenvStatus(),

  rebuildVenv: async () => profiles.rebuildEmbedVenv(),

  /**
   * Create or update a speaker profile from a single speaker key on a
   * recording. The recording must already have embeddings attached (produced
   * by post-processing). If none, the call is a no-op and returns `null`.
   */
  saveFromRecording: async (
    recordingId: string,
    speakerKey: string,
    name: string,
  ) => {
    const meta = await history.getRecordingMeta(recordingId);
    const embedding = meta.speakerEmbeddings?.[speakerKey];
    if (!embedding) return null;
    const profile = await profiles.upsertProfile({
      name,
      embedding,
      sampleCount: 1,
    });
    // Backfill the match record so the UI reflects the new association.
    const nextMatches: NonNullable<RecordingMeta["speakerMatches"]> = {
      ...(meta.speakerMatches ?? {}),
      [speakerKey]: {
        profileId: profile.id,
        profileName: profile.name,
        confidence: 1,
        matched: true,
      },
    };
    await history.updateRecording(recordingId, {
      speakerMatches: nextMatches,
    });
    return profile;
  },

  /** Inline rename applied to a single recording's display names. */
  renameSpeakerOnRecording: async (
    recordingId: string,
    speakerKey: string,
    name: string,
  ) => {
    const meta = await history.getRecordingMeta(recordingId);
    const next = { ...(meta.speakerNames ?? {}) };
    if (name.trim()) {
      next[speakerKey] = name.trim();
    } else {
      delete next[speakerKey];
    }
    await history.updateRecording(recordingId, { speakerNames: next });
    return next;
  },
};
