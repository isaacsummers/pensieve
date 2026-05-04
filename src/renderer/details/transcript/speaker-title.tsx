import { FC, useEffect, useRef, useState } from "react";
import {
  Avatar,
  Badge,
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
  HiOutlineUserCircle,
  HiOutlineUserGroup,
  HiOutlineXMark,
} from "react-icons/hi2";

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
}> = ({ timeText, speaker, displayName, match, onRename, onSaveProfile }) => {
  const effective = displayName?.trim() || defaultLabel(speaker);
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(effective);
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

  return (
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
          {match?.matched && match.profileName && (
            <Tooltip
              content={`Auto-labeled from profile \u201C${match.profileName}\u201D (similarity ${match.confidence.toFixed(2)})`}
            >
              <Badge color="jade" variant="soft">
                auto · {Math.round(match.confidence * 100)}%
              </Badge>
            </Tooltip>
          )}
          {match && !match.matched && match.profileName && (
            <Tooltip
              content={`Closest profile \u201C${match.profileName}\u201D scored ${match.confidence.toFixed(2)} (below threshold)`}
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
          <Text color="gray">{timeText}</Text>
        </>
      )}
    </Flex>
  );
};
