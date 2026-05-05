import { FC, useMemo, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Flex,
  Text,
  Tooltip,
} from "@radix-ui/themes";
import { HiOutlineUserCircle } from "react-icons/hi2";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RecordingMeta, RecordingTranscript } from "../../types";
import { speakerProfilesApi } from "../api";
import { QueryKeys } from "../../query-keys";
import { SpeakerDirectoryPicker } from "./transcript/speaker-directory-picker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getInitials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

/**
 * Deterministic hue from an arbitrary string (profile id or speaker key).
 * Returns a CSS `hsl(...)` string.
 */
const hashColor = (seed: string): string => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 50%)`;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MatchKind = "matched" | "suggested" | "assigned" | "none";

interface SpeakerRow {
  speakerKey: string;
  displayName: string;
  matchKind: MatchKind;
  profileId: string | null;
  confidence: number;
  segmentCount: number;
  overrideCount: number;
}

// ---------------------------------------------------------------------------
// Derive per-speaker rows from meta + transcript
// ---------------------------------------------------------------------------

function buildSpeakerRows(
  meta: RecordingMeta,
  transcript: RecordingTranscript | null | undefined,
  profilesById: Record<string, { id: string; name: string; avatar?: string }>,
): SpeakerRow[] {
  const items = transcript?.transcription ?? [];

  // Collect all speaker keys that appear in the transcript
  const keysInTranscript = new Set<string>();
  const segmentsByKey: Record<string, number> = {};
  for (const item of items) {
    const k = item.speaker;
    if (k != null && k !== "") {
      keysInTranscript.add(k);
      segmentsByKey[k] = (segmentsByKey[k] ?? 0) + 1;
    }
  }

  // Also include any keys in speakerMatches even if not in current transcript
  const allKeys = new Set<string>([
    ...keysInTranscript,
    ...Object.keys(meta.speakerMatches ?? {}),
  ]);

  if (allKeys.size === 0) return [];

  // Count per-item overrides for each speakerKey.
  // An override "belongs" to a key when:
  //   - the overridden profileId matches the recording-level profileId for that key, OR
  //   - the transcript item at that index has speaker === key
  const overrideCountByKey: Record<string, number> = {};
  const overrides = meta.speakerItemOverrides ?? {};
  for (const [idxStr, profileId] of Object.entries(overrides)) {
    const idx = Number(idxStr);
    const itemSpeakerKey = items[idx]?.speaker ?? null;
    for (const key of allKeys) {
      const matchProfileId = meta.speakerMatches?.[key]?.profileId ?? null;
      if (
        (matchProfileId !== null && profileId === matchProfileId) ||
        itemSpeakerKey === key
      ) {
        overrideCountByKey[key] = (overrideCountByKey[key] ?? 0) + 1;
        break; // each override belongs to at most one key
      }
    }
  }

  const rows: SpeakerRow[] = [];

  for (const key of Array.from(allKeys).sort()) {
    const match = meta.speakerMatches?.[key];
    const profileId = match?.profileId ?? null;
    const confidence = match?.confidence ?? 0;
    const matched = match?.matched ?? false;

    // Determine match kind
    let matchKind: MatchKind;
    if (matched && confidence === 1.0) {
      matchKind = "assigned"; // manually assigned
    } else if (matched && confidence > 0) {
      matchKind = "matched"; // auto matched high confidence
    } else if (!matched && confidence > 0) {
      matchKind = "suggested"; // low confidence suggestion
    } else {
      matchKind = "none";
    }

    // Resolve display name
    let displayName: string;
    const explicitName = meta.speakerNames?.[key];
    if (explicitName) {
      displayName = explicitName;
    } else if (profileId && profilesById[profileId]) {
      displayName = profilesById[profileId].name;
    } else if (match?.profileName) {
      displayName = match.profileName;
    } else if (key === "0") {
      displayName = "They";
    } else if (key === "1") {
      displayName = "Me";
    } else {
      displayName = `Speaker ${key}`;
    }

    rows.push({
      speakerKey: key,
      displayName,
      matchKind,
      profileId,
      confidence,
      segmentCount: segmentsByKey[key] ?? 0,
      overrideCount: overrideCountByKey[key] ?? 0,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Badge component for match status
// ---------------------------------------------------------------------------

const MatchBadge: FC<{ kind: MatchKind }> = ({ kind }) => {
  switch (kind) {
    case "matched":
      return (
        <Badge color="green" size="1">
          ✓ Matched
        </Badge>
      );
    case "suggested":
      return (
        <Badge color="amber" size="1">
          Suggested
        </Badge>
      );
    case "assigned":
      return (
        <Badge color="blue" size="1">
          Assigned
        </Badge>
      );
    default:
      return (
        <Badge color="gray" size="1">
          Unidentified
        </Badge>
      );
  }
};

// ---------------------------------------------------------------------------
// Individual speaker row
// ---------------------------------------------------------------------------

const SpeakerRowItem: FC<{
  row: SpeakerRow;
  recordingId: string;
  onIdentify: (speakerKey: string) => void;
  onClearOverrides: (speakerKey: string) => void;
  clearingOverrides: boolean;
  profileAvatarSrc?: string;
}> = ({
  row,
  onIdentify,
  onClearOverrides,
  clearingOverrides,
  profileAvatarSrc,
}) => {
  const avatarSeed = row.profileId ?? row.speakerKey;

  return (
    <Flex
      align="center"
      gap="0.75rem"
      px="1rem"
      py="0.75rem"
      style={{
        border: "1px solid var(--gray-a4)",
        borderRadius: 8,
        background: "var(--color-panel)",
      }}
    >
      {/* Avatar */}
      <Avatar
        size="3"
        fallback={getInitials(row.displayName) || "?"}
        src={profileAvatarSrc}
        style={{ flexShrink: 0, background: hashColor(avatarSeed) }}
      />

      {/* Name + badges */}
      <Flex direction="column" gap="0.25rem" style={{ flex: 1, minWidth: 0 }}>
        <Text weight="medium" truncate>
          {row.displayName}
        </Text>
        <Flex align="center" gap="0.4rem" wrap="wrap">
          <MatchBadge kind={row.matchKind} />
          {row.confidence > 0 && (
            <Badge color="gray" variant="surface" size="1">
              {Math.round(row.confidence * 100)}%
            </Badge>
          )}
          <Badge color="gray" variant="outline" size="1">
            {row.segmentCount} {row.segmentCount === 1 ? "segment" : "segments"}
          </Badge>
          {row.overrideCount > 0 && (
            <Tooltip content="Clear all per-segment overrides for this speaker">
              <Button
                variant="ghost"
                size="1"
                color="amber"
                style={{ fontSize: "var(--font-size-1)", height: "auto", padding: "1px 6px" }}
                onClick={() => onClearOverrides(row.speakerKey)}
                disabled={clearingOverrides}
              >
                {row.overrideCount} segment{row.overrideCount === 1 ? "" : "s"} overridden — clear
              </Button>
            </Tooltip>
          )}
        </Flex>
      </Flex>

      {/* Identify / Reassign button */}
      <Button
        variant="soft"
        size="2"
        style={{ flexShrink: 0 }}
        onClick={() => onIdentify(row.speakerKey)}
      >
        {row.matchKind === "none" ? "Identify" : "Reassign"}
      </Button>
    </Flex>
  );
};

// ---------------------------------------------------------------------------
// Main tab component
// ---------------------------------------------------------------------------

export interface SpeakersTabProps {
  recordingId: string;
  meta: RecordingMeta;
  transcript: RecordingTranscript | null | undefined;
  onMetaUpdated: () => void;
}

export const SpeakersTab: FC<SpeakersTabProps> = ({
  recordingId,
  meta,
  transcript,
  onMetaUpdated,
}) => {
  const qc = useQueryClient();
  const [pickerSpeakerKey, setPickerSpeakerKey] = useState<string | null>(null);
  const [clearingKey, setClearingKey] = useState<string | null>(null);

  const { data: profiles } = useQuery({
    queryKey: [QueryKeys.SpeakerProfiles],
    queryFn: speakerProfilesApi.list,
    staleTime: 30_000,
  });

  const profilesById = useMemo(() => {
    if (!profiles) return {};
    return Object.fromEntries(profiles.map((p) => [p.id, p]));
  }, [profiles]);

  const rows = useMemo(
    () => buildSpeakerRows(meta, transcript, profilesById),
    [meta, transcript, profilesById],
  );

  const clearOverridesMutation = useMutation({
    mutationFn: (speakerKey: string) =>
      speakerProfilesApi.clearAllItemOverridesForSpeakerKey(recordingId, speakerKey),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QueryKeys.History, recordingId] });
      onMetaUpdated();
    },
    onSettled: () => setClearingKey(null),
  });

  const handleClearOverrides = (speakerKey: string) => {
    setClearingKey(speakerKey);
    clearOverridesMutation.mutate(speakerKey);
  };

  const handleAssigned = () => {
    setPickerSpeakerKey(null);
    qc.invalidateQueries({ queryKey: [QueryKeys.History, recordingId] });
    onMetaUpdated();
  };

  // Empty state: no diarization data at all
  if (rows.length === 0) {
    return (
      <Flex
        direction="column"
        align="center"
        justify="center"
        gap="0.75rem"
        py="3rem"
        px="2rem"
        style={{ color: "var(--gray-11)" }}
      >
        <HiOutlineUserCircle style={{ fontSize: 40, opacity: 0.4 }} />
        <Text align="center" color="gray" size="2">
          No speakers detected — run post-processing to identify speakers.
        </Text>
      </Flex>
    );
  }

  const activePicker =
    pickerSpeakerKey !== null
      ? rows.find((r) => r.speakerKey === pickerSpeakerKey)
      : null;

  return (
    <Flex direction="column" gap="0.5rem" p="1rem">
      {rows.map((row) => {
        const avatarSrc = row.profileId
          ? `speakeravatar://${row.profileId}`
          : undefined;
        return (
          <SpeakerRowItem
            key={row.speakerKey}
            row={row}
            recordingId={recordingId}
            onIdentify={setPickerSpeakerKey}
            onClearOverrides={handleClearOverrides}
            clearingOverrides={
              clearingKey === row.speakerKey && clearOverridesMutation.isPending
            }
            profileAvatarSrc={avatarSrc}
          />
        );
      })}

      {/* Directory picker dialog */}
      {activePicker && (
        <SpeakerDirectoryPicker
          speakerKey={activePicker.speakerKey}
          recordingId={recordingId}
          currentProfileId={activePicker.profileId ?? undefined}
          currentSpeakerName={activePicker.displayName}
          onAssigned={handleAssigned}
          onClose={() => setPickerSpeakerKey(null)}
        />
      )}
    </Flex>
  );
};
