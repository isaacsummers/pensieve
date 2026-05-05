import * as profiles from "../domain/speaker-profiles";
import * as history from "../domain/history";
import { RecordingMeta } from "../../types";

export const speakerProfilesApi = {
  list: async () => profiles.listProfiles(),

  rename: async (id: string, name: string) => profiles.renameProfile(id, name),

  /** Update the aliases list for a profile. */
  updateAliases: async (id: string, aliases: string[]) =>
    profiles.updateSpeakerAliases(id, aliases),

  remove: async (id: string) => profiles.removeProfile(id),

  getStatus: async () => profiles.getLastError(),

  testPipeline: async () => profiles.testPipeline(),

  installDeps: async () => profiles.installEmbedDeps(),

  getVenvStatus: async () => profiles.getVenvStatus(),

  checkUvAvailable: async () => profiles.checkUvAvailable(),

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

  /**
   * Confirm a speaker suggestion: mark the match as confirmed, apply a
   * running-mean embedding update on the matched profile, and persist both.
   * Returns updated speakerMatches so the renderer can update its local state.
   */
  confirmSpeakerMatch: async (
    recordingId: string,
    speakerKey: string,
    profileId: string,
  ) => profiles.confirmSpeakerMatch(recordingId, speakerKey, profileId),

  /**
   * Reject a speaker suggestion: record the rejection so the pill is not
   * shown again. Returns updated speakerMatches.
   */
  rejectSpeakerSuggestion: async (
    recordingId: string,
    speakerKey: string,
    profileId: string,
  ) => profiles.rejectSpeakerSuggestion(recordingId, speakerKey, profileId),

  /**
   * Merge multiple profiles into one canonical profile. The canonical
   * profile's embedding is recomputed as the weighted mean of all
   * participants; absorbed profiles are deleted; all recording metas are
   * updated to point to the canonical id.
   */
  mergeSpeakerProfiles: async (
    canonicalId: string,
    absorbedIds: string[],
  ) => profiles.mergeSpeakerProfiles(canonicalId, absorbedIds),

  /**
   * Non-destructive manual assignment: link a speaker key on a single
   * recording to a profile. Does NOT touch the profile's embedding — that
   * is a separate opt-in step via updateProfileEmbeddingFromRecording.
   *
   * Returns { ok, profile, suggestEmbeddingUpdate }.
   */
  assignSpeakerToProfile: async (
    recordingId: string,
    speakerKey: string,
    profileId: string,
  ) => profiles.assignSpeakerToProfile(recordingId, speakerKey, profileId),

  /**
   * Refine a profile's voice model using the raw embedding stored on a
   * recording for a given speaker key. Opt-in and explicit — should only
   * be called when the user explicitly confirms they want to update the
   * model (e.g. after a manual assignment).
   *
   * Returns the updated profile.
   */
  updateProfileEmbeddingFromRecording: async (
    recordingId: string,
    speakerKey: string,
    profileId: string,
  ) =>
    profiles.updateProfileEmbeddingFromRecording(
      recordingId,
      speakerKey,
      profileId,
    ),

  /**
   * Set the avatar for a speaker profile from a base64 data URL.
   * Returns the updated profile.
   */
  setSpeakerAvatar: async (
    profileId: string,
    imageDataUrl: string,
  ) => profiles.setSpeakerAvatar(profileId, imageDataUrl),

  /**
   * Return the full filesystem path to the avatar file for `profileId`,
   * or null if none is set / file is missing.
   */
  getSpeakerAvatarPath: async (profileId: string) =>
    profiles.getSpeakerAvatarPath(profileId),

  /**
   * Delete the avatar file for `profileId` and clear `profile.avatar`.
   */
  deleteSpeakerAvatar: async (profileId: string) =>
    profiles.deleteSpeakerAvatar(profileId),
};
