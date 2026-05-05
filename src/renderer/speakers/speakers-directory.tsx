import { FC, useEffect, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Flex,
  Grid,
  Heading,
  IconButton,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import {
  HiOutlineMagnifyingGlass,
  HiOutlinePlusCircle,
  HiOutlineUserCircle,
} from "react-icons/hi2";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { SpeakerProfile, RecordingMeta } from "../../types";
import { speakerProfilesApi, historyApi } from "../api";
import { QueryKeys } from "../../query-keys";
import { SpeakerProfileDetail } from "./speaker-profile-detail";

const getInitials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

/** Return a map of profileId → count of recordings that mention it. */
function buildRecordingCounts(
  allMetas: Record<string, RecordingMeta>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const meta of Object.values(allMetas)) {
    const seen = new Set<string>();
    for (const match of Object.values(meta.speakerMatches ?? {})) {
      if (match.profileId && !seen.has(match.profileId)) {
        seen.add(match.profileId);
        counts[match.profileId] = (counts[match.profileId] ?? 0) + 1;
      }
    }
  }
  return counts;
}

/** Return the most recent started date across all recordings that mention this profile. */
function buildLastSeen(
  allMetas: Record<string, RecordingMeta>,
): Record<string, string> {
  const lastSeen: Record<string, string> = {};
  for (const meta of Object.values(allMetas)) {
    for (const match of Object.values(meta.speakerMatches ?? {})) {
      if (match.profileId) {
        const prev = lastSeen[match.profileId];
        if (!prev || meta.started > prev) {
          lastSeen[match.profileId] = meta.started;
        }
      }
    }
  }
  return lastSeen;
}

const ProfileCard: FC<{
  profile: SpeakerProfile;
  avatarUrl: string | null;
  recordingCount: number;
  lastSeen?: string;
  onClick: () => void;
}> = ({ profile, avatarUrl, recordingCount, lastSeen, onClick }) => (
  <Flex
    direction="column"
    align="center"
    gap="0.5rem"
    p="1rem"
    style={{
      cursor: "pointer",
      border: "1px solid var(--gray-a5)",
      borderRadius: 10,
      background: "var(--color-panel)",
      transition: "border-color 0.15s, background 0.15s",
    }}
    className="speaker-card"
    onClick={onClick}
  >
    <Avatar
      size="4"
      fallback={getInitials(profile.name) || "?"}
      src={avatarUrl ?? undefined}
      style={{ flexShrink: 0 }}
    />
    <Text weight="bold" align="center" truncate style={{ maxWidth: "100%" }}>
      {profile.name}
    </Text>
    {profile.aliases && profile.aliases.length > 0 && (
      <Text size="1" color="gray" align="center" truncate style={{ maxWidth: "100%" }}>
        {profile.aliases.join(", ")}
      </Text>
    )}
    <Flex gap="0.5rem" wrap="wrap" justify="center">
      <Badge color="blue" size="1">
        {recordingCount} recording{recordingCount !== 1 ? "s" : ""}
      </Badge>
      {lastSeen && (
        <Badge color="gray" size="1">
          {new Date(lastSeen).toLocaleDateString()}
        </Badge>
      )}
    </Flex>
  </Flex>
);

export const SpeakersDirectory: FC = () => {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string | null>>({});

  const { data: profiles, isLoading: profilesLoading } = useQuery({
    queryKey: [QueryKeys.SpeakerProfiles],
    queryFn: speakerProfilesApi.list,
    staleTime: 30_000,
  });

  const { data: allRecordings } = useQuery({
    queryKey: [QueryKeys.History],
    queryFn: historyApi.getRecordings,
    staleTime: 60_000,
  });

  const recordingCounts = buildRecordingCounts(allRecordings ?? {});
  const lastSeenMap = buildLastSeen(allRecordings ?? {});

  // Load avatar paths when profiles change.
  useEffect(() => {
    if (!profiles) return;
    for (const profile of profiles) {
      if (profile.avatar) {
        void speakerProfilesApi
          .getSpeakerAvatarPath(profile.id)
          .then((p) => {
            setAvatarUrls((prev) => ({ ...prev, [profile.id]: p ? `file://${p}` : null }));
          });
      } else {
        setAvatarUrls((prev) =>
          prev[profile.id] !== null ? { ...prev, [profile.id]: null } : prev,
        );
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles?.map((p) => `${p.id}:${p.avatar ?? ""}`).join(",")]);

  const addSpeakerMutation = useMutation({
    mutationFn: async (name: string) => {
      return speakerProfilesApi.createSpeakerProfile(name);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QueryKeys.SpeakerProfiles] });
    },
  });

  const handleAddSpeaker = async () => {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    try {
      await addSpeakerMutation.mutateAsync(name);
      setShowAddModal(false);
      setNewName("");
    } finally {
      setAdding(false);
    }
  };

  const filtered = (profiles ?? []).filter((p) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      (p.aliases ?? []).some((a) => a.toLowerCase().includes(q))
    );
  });

  if (selectedProfileId) {
    const profile = (profiles ?? []).find((p) => p.id === selectedProfileId);
    if (profile) {
      return (
        <SpeakerProfileDetail
          profile={profile}
          avatarUrl={avatarUrls[profile.id] ?? null}
          allRecordings={allRecordings ?? {}}
          onBack={() => setSelectedProfileId(null)}
          onAvatarChange={(url) => {
            setAvatarUrls((prev) => ({ ...prev, [profile.id]: url }));
          }}
        />
      );
    }
  }

  return (
    <Flex direction="column" gap="1rem" p="1.5rem" style={{ height: "100%", overflowY: "auto" }}>
      <Flex align="center" justify="between" gap="1rem">
        <Heading size="5">Speakers</Heading>
        <Button onClick={() => setShowAddModal(true)}>
          <HiOutlinePlusCircle /> Add speaker
        </Button>
      </Flex>

      <TextField.Root
        placeholder="Search speakers…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      >
        <TextField.Slot>
          <HiOutlineMagnifyingGlass />
        </TextField.Slot>
      </TextField.Root>

      {profilesLoading && (
        <Flex align="center" justify="center" py="3rem" gap="0.5rem">
          <Spinner size="3" />
          <Text color="gray">Loading speakers…</Text>
        </Flex>
      )}

      {!profilesLoading && filtered.length === 0 && (
        <Flex align="center" justify="center" py="3rem">
          <Text color="gray">
            {search ? "No speakers match your search." : "No speaker profiles yet."}
          </Text>
        </Flex>
      )}

      <Grid columns={{ initial: "1", sm: "2", md: "3", lg: "4" }} gap="1rem">
        {filtered.map((p) => (
          <ProfileCard
            key={p.id}
            profile={p}
            avatarUrl={avatarUrls[p.id] ?? null}
            recordingCount={recordingCounts[p.id] ?? 0}
            lastSeen={lastSeenMap[p.id]}
            onClick={() => setSelectedProfileId(p.id)}
          />
        ))}
      </Grid>

      {/* Add speaker dialog */}
      <Dialog.Root open={showAddModal} onOpenChange={(open) => { if (!open) setShowAddModal(false); }}>
        <Dialog.Content maxWidth="360px">
          <Dialog.Title>Add speaker</Dialog.Title>
          <TextField.Root
            placeholder="Speaker name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddSpeaker();
              if (e.key === "Escape") { setShowAddModal(false); setNewName(""); }
            }}
            autoFocus
            mt="0.5rem"
          />
          <Flex justify="end" gap="0.5rem" mt="1rem">
            <Dialog.Close>
              <Button variant="soft" color="gray" onClick={() => setShowAddModal(false)}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button disabled={!newName.trim() || adding} onClick={handleAddSpeaker}>
              {adding ? <Spinner size="1" /> : "Create"}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Flex>
  );
};
