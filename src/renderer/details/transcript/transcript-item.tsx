import { memo, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { RecordingMeta, RecordingTranscriptItem } from "../../../types";
import { useManagedAudio } from "../use-managed-audio";
import { isInRange, useEvent } from "../../../utils";
import { speakerProfilesApi } from "../../api";
import { TranscriptItemUi } from "./transcript-item-ui";
import { Screenshot } from "./screenshot";
import { TimeframedComment } from "./timeframed-comment";
import { QueryKeys } from "../../../query-keys";

/** Default suggest threshold used when settings have not yet loaded. */
const DEFAULT_SUGGEST_THRESHOLD = 0.65;

export const TranscriptItem = memo<{
  item: RecordingTranscriptItem;
  priorItem?: RecordingTranscriptItem;
  nextItem?: RecordingTranscriptItem;
  audio: ReturnType<typeof useManagedAudio>;
  meta: RecordingMeta;
  updateMeta: (update: Partial<RecordingMeta>) => Promise<void>;
  recordingId: string;
  index: number;
}>(
  ({
    index,
    item,
    priorItem,
    nextItem,
    audio,
    meta,
    updateMeta,
    recordingId,
  }) => {
    const text = item.text.trim();
    const time = new Date();
    time.setMilliseconds(item.offsets.from);
    const isProgressAtItem =
      audio.progress !== 0 &&
      audio.progress * 1000 >= item.offsets.from &&
      audio.progress * 1000 < item.offsets.to;
    const priorRange = useMemo(
      () =>
        [
          priorItem?.offsets.from ?? Number.MIN_SAFE_INTEGER,
          item.offsets.from,
        ] as const,
      [item.offsets.from, priorItem?.offsets.from],
    );
    const nextRange = useMemo(
      () =>
        [
          item.offsets.to,
          nextItem?.offsets.to ?? Number.MAX_SAFE_INTEGER,
        ] as const,
      [item.offsets.to, nextItem?.offsets.to],
    );

    const isHighlighted = useMemo(
      () => meta.highlights?.some((time) => isInRange(time, priorRange)),
      [meta.highlights, priorRange],
    );

    const timeText = useMemo(() => {
      const min = Math.floor(item.offsets.from / 60000)
        .toString()
        .padStart(2, "0");
      const sec = Math.floor((item.offsets.from % 60000) / 1000)
        .toString()
        .padStart(2, "0");
      return `${min}:${sec}`;
    }, [item.offsets.from]);

    const onTogglePlaying = useEvent(() => {
      if (audio.isPlaying && isProgressAtItem) {
        audio.pause();
      } else {
        audio.jump(item.offsets.from / 1000);
        audio.play();
      }
    });

    const onToggleHighlight = useEvent(() => {
      if (isHighlighted) {
        updateMeta({
          highlights: meta.highlights?.filter(
            (time) => !isInRange(time, priorRange),
          ),
        });
      } else {
        updateMeta({
          highlights: [...(meta.highlights ?? []), item.offsets.from - 0.1],
        });
      }
    });

    const timestampedNotes = useMemo(
      () =>
        (
          Object.entries(meta.timestampedNotes ?? {}) as any as [
            number,
            string,
          ][]
        )
          .filter(([time]) => isInRange(time, nextRange))
          .map(([time, note]) => ({ time, note })),
      [meta.timestampedNotes, nextRange],
    );

    const screenshots = useMemo(
      () =>
        (Object.entries(meta.screenshots ?? {}) as any as [number, string][])
          .filter(
            ([time], idx) =>
              isInRange(time, nextRange) ||
              (idx === 0 && index === 0 && time < nextRange[0]),
          )
          .map(([time, file]) => ({ time, file })),
      [index, meta.screenshots, nextRange],
    );

    const nextItems = useMemo(
      () => (
        <>
          {timestampedNotes.map(({ time, note }) => (
            <TimeframedComment note={note} key={time} />
          ))}
          {screenshots.map(({ file }) => (
            <Screenshot
              url={`screenshot://${recordingId}/${file}`}
              key={file}
            />
          ))}
        </>
      ),
      [timestampedNotes, screenshots, recordingId],
    );

    const onRenameSpeaker = useCallback(
      async (name: string) => {
        const next = await speakerProfilesApi.renameSpeakerOnRecording(
          recordingId,
          item.speaker,
          name,
        );
        await updateMeta({ speakerNames: next });
      },
      [recordingId, item.speaker, updateMeta],
    );

    const onSaveAsProfile = useCallback(
      async (name: string) => {
        const profile = await speakerProfilesApi.saveFromRecording(
          recordingId,
          item.speaker,
          name,
        );
        if (!profile) {
          // No embedding available — surface in meta so the UI can show it.
          await updateMeta({
            pipelineError: {
              stage: "save-profile",
              message:
                "No voice embedding found for this speaker. Re-run post-processing to generate embeddings.",
            },
          });
        }
      },
      [recordingId, item.speaker, updateMeta],
    );

    // --- speaker profiles for live name resolution --------------------------

    const { data: allProfiles } = useQuery({
      queryKey: [QueryKeys.SpeakerProfiles],
      queryFn: speakerProfilesApi.list,
      staleTime: 60_000,
    });

    const profilesById = useMemo(() => {
      const map: Record<string, { name: string }> = {};
      for (const p of allProfiles ?? []) {
        map[p.id] = { name: p.name };
      }
      return map;
    }, [allProfiles]);

    const speakerMatch = meta.speakerMatches?.[item.speaker];

    /**
     * Resolution order:
     *  1. Per-item override (speakerItemOverrides[index]) — highest priority
     *  2. Explicit per-recording override (user typed a custom name)
     *  3. Live profile name lookup via speakerMatches profileId
     *  4. undefined (SpeakerTitle will fall back to "Speaker N")
     */
    const itemOverrideProfileId = meta.speakerItemOverrides?.[String(index)];
    const hasItemOverride = !!itemOverrideProfileId;
    const speakerDisplayName =
      (itemOverrideProfileId
        ? profilesById[itemOverrideProfileId]?.name
        : undefined) ??
      meta.speakerNames?.[item.speaker] ??
      (speakerMatch?.profileId
        ? profilesById[speakerMatch.profileId]?.name
        : undefined);

    const onConfirmSpeakerMatch = useCallback(
      async (profileId: string) => {
        const nextMatches = await speakerProfilesApi.confirmSpeakerMatch(
          recordingId,
          item.speaker,
          profileId,
        );
        await updateMeta({ speakerMatches: nextMatches });
      },
      [recordingId, item.speaker, updateMeta],
    );

    const onRejectSpeakerSuggestion = useCallback(
      async (profileId: string) => {
        const nextMatches = await speakerProfilesApi.rejectSpeakerSuggestion(
          recordingId,
          item.speaker,
          profileId,
        );
        await updateMeta({ speakerMatches: nextMatches });
      },
      [recordingId, item.speaker, updateMeta],
    );

    const onAssignSpeakerToProfile = useCallback(
      async (profileId: string) => {
        const result = await speakerProfilesApi.assignSpeakerToProfile(
          recordingId,
          item.speaker,
          profileId,
        );
        if (result.profile) {
          await updateMeta({
            speakerMatches: {
              ...(meta.speakerMatches ?? {}),
              [item.speaker]: {
                profileId: result.profile.id,
                profileName: result.profile.name,
                confidence: 1.0,
                matched: true,
              },
            },
          });
        }
      },
      [recordingId, item.speaker, updateMeta, meta.speakerMatches],
    );

    const onItemOverrideApplied = useCallback(
      async (_itemIndex: number, profileId: string) => {
        // The IPC was already called by the picker (setTranscriptItemSpeakerOverride).
        // We just need to update the local meta to reflect the new override.
        const nextOverrides = {
          ...(meta.speakerItemOverrides ?? {}),
          [String(index)]: profileId,
        };
        await updateMeta({ speakerItemOverrides: nextOverrides });
      },
      [index, meta.speakerItemOverrides, updateMeta],
    );

    const onClearItemOverride = useCallback(
      async (_itemIndex: number) => {
        await speakerProfilesApi.clearTranscriptItemSpeakerOverride(
          recordingId,
          index,
        );
        const nextOverrides = { ...(meta.speakerItemOverrides ?? {}) };
        delete nextOverrides[String(index)];
        await updateMeta({ speakerItemOverrides: nextOverrides });
      },
      [recordingId, index, meta.speakerItemOverrides, updateMeta],
    );

    return (
      <TranscriptItemUi
        key={item.timestamps.from}
        text={text}
        speaker={item.speaker}
        speakerDisplayName={speakerDisplayName}
        speakerMatch={speakerMatch}
        onRenameSpeaker={onRenameSpeaker}
        onSaveSpeakerProfile={onSaveAsProfile}
        onConfirmSpeakerMatch={onConfirmSpeakerMatch}
        onRejectSpeakerSuggestion={onRejectSpeakerSuggestion}
        onAssignSpeakerToProfile={onAssignSpeakerToProfile}
        recordingId={recordingId}
        suggestThreshold={DEFAULT_SUGGEST_THRESHOLD}
        rejectedSuggestions={meta.rejectedSuggestions?.[item.speaker]}
        isProgressAtItem={isProgressAtItem}
        isAudioPlaying={audio.isPlaying}
        isHighlighted={!!isHighlighted}
        isNewSpeaker={
          item.speaker !== priorItem?.speaker || text.startsWith("- ")
        }
        timeText={timeText}
        time={item.offsets.from}
        onTogglePlaying={onTogglePlaying}
        onToggleHighlight={onToggleHighlight}
        nextItems={nextItems}
        itemIndex={index}
        hasItemOverride={hasItemOverride}
        onItemOverrideApplied={onItemOverrideApplied}
        onClearItemOverride={onClearItemOverride}
      />
    );
  },
);
