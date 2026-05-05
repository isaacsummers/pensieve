import { FC, useEffect, useRef, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Flex,
  IconButton,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import {
  HiCheck,
  HiMiniPencilSquare,
  HiOutlineBookmarkSquare,
  HiOutlineIdentification,
  HiOutlineUserCircle,
  HiOutlineUserGroup,
  HiOutlineXMark,
} from "react-icons/hi2";
import { SpeakerDirectoryPicker } from "./speaker-directory-picker";

const defaultLabel = (speakerKey: string) => {
  if (speakerKey === "0") return "They";
  if (speakerKey === "1") return "Me";
  return `Speaker ${speakerKey}`;
};

export const SpeakerTitle: FC<{
  timeText: string;
  speaker: string;
  /** Optional override name (from recording meta.speakerNames). */
  displayName?: string;
  /** Optional match info from the embedding pipeline. */
  match?: {
    profileId: string | null;
    profileName: string | null;
    confidence: number;
    matched: boolean;
  };
  onRename?: (name: string) => Promise<void> | void;
  onSaveProfile?: (name: string) => Promise<void> | void;
  /** Called when the user clicks ✓ on a suggestion pill. */
  onConfirmMatch?: (profileId: string) => Promise<void> | void;
  /** Called when the user clicks ✗ on a suggestion pill. */
  onRejectSuggestion?: (profileId: string) => Promise<void> | void;
  /** Called when the user assigns a speaker to a profile via the directory picker. */
  onAssignToProfile?: (profileId: string) => Promise<void> | void;
  /** Called when the assignment suggests an embedding update is available. */
  onSuggestEmbeddingUpdate?: (profileId: string) => void;
  /** Minimum confidence to show the suggestion pill (default 0.65). */
  suggestThreshold?: number;
  /** Profile IDs the user has already rejected for this speaker/recording. */
  rejectedSuggestions?: string[];
  /** recordingId, needed to pass to the picker for assignment. */
  recordingId?: string;
}> = ({
  timeText,
  speaker,
  displayName,
  match,
  onRename,
  onSaveProfile,
  onConfirmMatch,
  onRejectSuggestion,
  onAssignToProfile,
  onSuggestEmbeddingUpdate,
  suggestThreshold = 0.65,
  rejectedSuggestions,
  recordingId,
}) => {
  const effective = displayName?.trim() || defaultLabel(speaker);
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(effective);
  const [showPicker, setShowPicker] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setValue(effective);
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [isEditing, effective]);

  const commit = async () => {
    setIsEditing(false);
    if (!onRename) return;
    const next = value.trim();
    if (next === effective) return;
    await onRename(next);
  };

  const saveAsProfile = async () => {
    if (!onSaveProfile) return;
    const next = (displayName || value || effective).trim();
    if (!next) return;
    await onSaveProfile(next);
  };

  const isThey = effective === "They";
  const isMe = effective === "Me";

  const avatar = isMe ? (
    <Avatar fallback={<HiOutlineUserCircle />} size="2" />
  ) : isThey ? (
    <Avatar fallback={<HiOutlineUserGroup />} size="2" />
  ) : (
    <Avatar fallback={effective.slice(0, 1).toUpperCase()} size="2" />
  );

  /**
   * Determine whether to show the suggestion pill:
   * - Match exists and is NOT confirmed (matched=false)
   * - Has a profileId and profileName
   * - Confidence is at/above the suggest threshold
   * - The profile has not been rejected on this recording
   */
  const showSuggestionPill =
    !match?.matched &&
    match?.profileId != null &&
    match?.profileName != null &&
    match.confidence >= suggestThreshold &&
    !(rejectedSuggestions ?? []).includes(match.profileId);

  return (
    <>
    <Flex align="center" gap=".5rem" className="hoverhide-container">
      {avatar}
      {isEditing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
          style={{ flexGrow: 1 }}
        >
          <Flex align="center" gap=".25rem">
            <TextField.Root
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setIsEditing(false);
                }
              }}
              style={{ minWidth: "12rem" }}
            >
              <TextField.Slot />
            </TextField.Root>
            <IconButton
              type="submit"
              size="1"
              variant="ghost"
              aria-label="Save speaker name"
            >
              <HiCheck />
            </IconButton>
            <IconButton
              type="button"
              size="1"
              variant="ghost"
              aria-label="Cancel rename"
              onClick={() => setIsEditing(false)}
            >
              <HiOutlineXMark />
            </IconButton>
          </Flex>
        </form>
      ) : (
        <>
          <Text weight="bold" style={{ flexGrow: 1 }}>
            {effective}
          </Text>
          {match?.matched && (
            <Tooltip
              content={`Auto-labeled from profile \u201C${
                match.profileName ?? effective
              }\u201D (similarity ${match.confidence.toFixed(2)})`}
            >
              <Badge color="jade" variant="soft">
                auto \u00b7 {Math.round(match.confidence * 100)}%
              </Badge>
            </Tooltip>
          )}
          {showSuggestionPill && match && (
            <Flex align="center" gap=".25rem">
              <Tooltip
                content={`Voice matches profile \u201C${match.profileName}\u201D with ${Math.round(match.confidence * 100)}% similarity. Confirm to link this speaker to the profile.`}
              >
                <Badge color="amber" variant="soft">
                  Suggested: {match.profileName} ({Math.round(match.confidence * 100)}%)
                </Badge>
              </Tooltip>
              <Tooltip content="Confirm: link this speaker to the suggested profile">
                <IconButton
                  size="1"
                  variant="ghost"
                  color="green"
                  aria-label="Confirm speaker suggestion"
                  onClick={() =>
                    match.profileId && onConfirmMatch?.(match.profileId)
                  }
                >
                  <HiCheck />
                </IconButton>
              </Tooltip>
              <Tooltip content="Dismiss suggestion for this recording">
                <IconButton
                  size="1"
                  variant="ghost"
                  color="red"
                  aria-label="Reject speaker suggestion"
                  onClick={() =>
                    match.profileId && onRejectSuggestion?.(match.profileId)
                  }
                >
                  <HiOutlineXMark />
                </IconButton>
              </Tooltip>
            </Flex>
          )}
          {!match?.matched && !showSuggestionPill && match && (
            <Tooltip
              content={
                match.profileName
                  ? `Closest profile \u201C${match.profileName}\u201D scored ${match.confidence.toFixed(2)} (below threshold)`
                  : "No voice profile matched this speaker"
              }
            >
              <Badge color="gray" variant="soft">
                no match
              </Badge>
            </Tooltip>
          )}
          {onRename && (
            <Tooltip content="Rename speaker on this recording">
              <IconButton
                variant="ghost"
                size="1"
                className="hoverhide-item"
                onClick={() => setIsEditing(true)}
                aria-label="Rename speaker"
              >
                <HiMiniPencilSquare />
              </IconButton>
            </Tooltip>
          )}
          {onSaveProfile && displayName && displayName.trim() && (
            <Tooltip content="Save current name as a reusable voice profile">
              <IconButton
                variant="ghost"
                size="1"
                className="hoverhide-item"
                onClick={saveAsProfile}
                aria-label="Save as profile"
              >
                <HiOutlineBookmarkSquare />
              </IconButton>
            </Tooltip>
          )}
          {/* Identify button — show when the speaker isn't fully matched yet */}
          {!match?.matched && onAssignToProfile && recordingId && (
            <Tooltip content="Identify this speaker from your profile directory">
              <IconButton
                variant="ghost"
                size="1"
                className="hoverhide-item"
                onClick={() => setShowPicker(true)}
                aria-label="Identify speaker"
              >
                <HiOutlineIdentification />
              </IconButton>
            </Tooltip>
          )}
          <Text color="gray">{timeText}</Text>
        </>
      )}
    </Flex>
    {showPicker && recordingId && onAssignToProfile && (
      <SpeakerDirectoryPicker
        speakerKey={speaker}
        recordingId={recordingId}
        currentProfileId={match?.profileId ?? undefined}
        onAssigned={async (profileId) => {
          setShowPicker(false);
          await onAssignToProfile(profileId);
        }}
        onClose={() => setShowPicker(false)}
        onSuggestEmbeddingUpdate={onSuggestEmbeddingUpdate}
      />
    )}
  </>
  );
};
