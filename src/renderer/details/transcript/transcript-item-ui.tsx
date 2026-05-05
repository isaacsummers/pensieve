import { Fragment, ReactNode, memo } from "react";
import { Box, Flex, IconButton, Text } from "@radix-ui/themes";
import {
  HiMiniStar,
  HiOutlinePause,
  HiOutlinePlay,
  HiOutlineStar,
} from "react-icons/hi2";
import { SpeakerTitle } from "./speaker-title";

export const TranscriptItemUi = memo<{
  text: string;
  speaker: string;
  speakerDisplayName?: string;
  speakerMatch?: {
    profileId: string | null;
    profileName: string | null;
    confidence: number;
    matched: boolean;
  };
  onRenameSpeaker?: (name: string) => Promise<void> | void;
  onSaveSpeakerProfile?: (name: string) => Promise<void> | void;
  onConfirmSpeakerMatch?: (profileId: string) => Promise<void> | void;
  onRejectSpeakerSuggestion?: (profileId: string) => Promise<void> | void;
  onAssignSpeakerToProfile?: (profileId: string) => Promise<void> | void;
  onSuggestEmbeddingUpdate?: (profileId: string) => void;
  recordingId?: string;
  suggestThreshold?: number;
  rejectedSuggestions?: string[];
  isProgressAtItem: boolean;
  isAudioPlaying: boolean;
  isHighlighted: boolean;
  isNewSpeaker: boolean;
  timeText: string;
  time: number;
  onTogglePlaying: () => void;
  onToggleHighlight: () => void;
  nextItems?: ReactNode;
  /** The item index within the transcript (for per-segment overrides). */
  itemIndex?: number;
  /** Whether a per-segment speaker override is active for this item. */
  hasItemOverride?: boolean;
  /** Called when a per-segment override is applied via the picker. */
  onItemOverrideApplied?: (itemIndex: number, profileId: string) => void;
  /** Called to clear the per-segment speaker override. */
  onClearItemOverride?: (itemIndex: number) => void;
}>(
  ({
    text,
    speaker,
    speakerDisplayName,
    speakerMatch,
    onRenameSpeaker,
    onSaveSpeakerProfile,
    onConfirmSpeakerMatch,
    onRejectSpeakerSuggestion,
    onAssignSpeakerToProfile,
    onSuggestEmbeddingUpdate,
    recordingId,
    suggestThreshold,
    rejectedSuggestions,
    isProgressAtItem,
    isAudioPlaying,
    isHighlighted,
    isNewSpeaker,
    timeText,
    time,
    onTogglePlaying,
    onToggleHighlight,
    nextItems,
    itemIndex,
    hasItemOverride,
    onItemOverrideApplied,
    onClearItemOverride,
  }) => (
    <>
      {(isNewSpeaker || hasItemOverride) && (
        <SpeakerTitle
          speaker={speaker}
          timeText={timeText}
          displayName={speakerDisplayName}
          match={speakerMatch}
          onRename={onRenameSpeaker}
          onSaveProfile={onSaveSpeakerProfile}
          onConfirmMatch={onConfirmSpeakerMatch}
          onRejectSuggestion={onRejectSpeakerSuggestion}
          onAssignToProfile={onAssignSpeakerToProfile}
          onSuggestEmbeddingUpdate={onSuggestEmbeddingUpdate}
          recordingId={recordingId}
          suggestThreshold={suggestThreshold}
          rejectedSuggestions={rejectedSuggestions}
          itemIndex={itemIndex}
          hasItemOverride={hasItemOverride}
          onItemOverrideApplied={onItemOverrideApplied}
          onClearOverride={onClearItemOverride}
        />
      )}
      <Box
        id={`transcript-item-${time}`}
        pl="calc(32px + 0.5rem)"
        mt=".2rem"
        mb="1rem"
        position="relative"
        className="hoverhide-container"
      >
        <Flex
          position="absolute"
          top="0"
          left="0"
          width="32px"
          gap=".2rem"
          justify="end"
        >
          <IconButton
            className="hoverhide-item"
            variant="outline"
            size="1"
            onClick={onTogglePlaying}
          >
            {isAudioPlaying && isProgressAtItem ? (
              <HiOutlinePause />
            ) : (
              <HiOutlinePlay />
            )}
          </IconButton>
          <IconButton
            variant="outline"
            color="yellow"
            size="1"
            onClick={onToggleHighlight}
            className={isHighlighted ? undefined : "hoverhide-item"}
          >
            {isHighlighted ? <HiMiniStar /> : <HiOutlineStar />}
          </IconButton>
        </Flex>
        <Text color={isProgressAtItem ? "blue" : undefined}>
          {text.startsWith("- ") ? text.slice(2) : text}
        </Text>
      </Box>
      {nextItems}
    </>
  ),
);
