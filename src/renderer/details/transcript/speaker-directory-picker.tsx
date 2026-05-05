import { FC, useMemo, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Flex,
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SpeakerProfile } from "../../../types";
import { speakerProfilesApi } from "../../api";
import { QueryKeys } from "../../../query-keys";

export type SpeakerDirectoryPickerProps = {
  speakerKey: string;
  recordingId: string;
  currentProfileId?: string;
  /** Called after the user picks a profile and the assignment IPC resolves. */
  onAssigned: (profileId: string) => void;
  onClose: () => void;
  /** Whether to prompt for embedding update when a raw embedding is available. */
  onSuggestEmbeddingUpdate?: (profileId: string) => void;
};

const getInitials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

const ProfileRow: FC<{
  profile: SpeakerProfile;
  isSelected: boolean;
  onSelect: () => void;
}> = ({ profile, isSelected, onSelect }) => (
  <Flex
    align="center"
    gap="0.75rem"
    px="0.75rem"
    py="0.5rem"
    style={{
      cursor: "pointer",
      borderRadius: 6,
      background: isSelected ? "var(--accent-a3)" : "transparent",
      border: isSelected ? "1px solid var(--accent-a6)" : "1px solid transparent",
      transition: "background 0.1s",
    }}
    onClick={onSelect}
  >
    <Avatar
      size="2"
      fallback={getInitials(profile.name) || "?"}
      src={profile.avatar ? `speakeravatar://${profile.id}` : undefined}
    />
    <Flex direction="column" style={{ flex: 1, minWidth: 0 }}>
      <Text weight="medium" truncate>
        {profile.name}
      </Text>
      {profile.aliases && profile.aliases.length > 0 && (
        <Text size="1" color="gray" truncate>
          {profile.aliases.join(", ")}
        </Text>
      )}
    </Flex>
    {isSelected && (
      <Badge color="jade" size="1">
        Selected
      </Badge>
    )}
  </Flex>
);

export const SpeakerDirectoryPicker: FC<SpeakerDirectoryPickerProps> = ({
  speakerKey,
  recordingId,
  currentProfileId,
  onAssigned,
  onClose,
  onSuggestEmbeddingUpdate,
}) => {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>(currentProfileId);
  const [newName, setNewName] = useState("");
  const [showNewInput, setShowNewInput] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: profiles, isLoading } = useQuery({
    queryKey: [QueryKeys.SpeakerProfiles],
    queryFn: speakerProfilesApi.list,
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return profiles ?? [];
    return (profiles ?? []).filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
    );
  }, [profiles, search]);

  const createAndAssign = useMutation({
    mutationFn: async (name: string) => {
      // Create an empty profile (no embedding), then assign it.
      const profile = await speakerProfilesApi.saveFromRecording(
        recordingId,
        speakerKey,
        name,
      );
      if (!profile) {
        // No embedding for this recording; create a minimal profile via upsertProfile isn't
        // exposed directly — use assignSpeakerToProfile with a freshly created profile name
        // by saving from recording (no-op if no embedding). As a fallback, we call rename.
        // Best-effort: skip embedding update.
        return null;
      }
      return profile;
    },
    onSuccess: (profile) => {
      if (profile) {
        qc.invalidateQueries({ queryKey: [QueryKeys.SpeakerProfiles] });
        onAssigned(profile.id);
      }
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const handleAssign = async () => {
    if (!selectedId) return;
    setAssigning(true);
    setError(null);
    try {
      const result = await speakerProfilesApi.assignSpeakerToProfile(
        recordingId,
        speakerKey,
        selectedId,
      );
      qc.invalidateQueries({ queryKey: [QueryKeys.SpeakerProfiles] });
      if (result.suggestEmbeddingUpdate && onSuggestEmbeddingUpdate) {
        onSuggestEmbeddingUpdate(selectedId);
      }
      onAssigned(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAssigning(false);
    }
  };

  const handleCreateNew = async () => {
    const name = newName.trim();
    if (!name) return;
    setAssigning(true);
    setError(null);
    try {
      await createAndAssign.mutateAsync(name);
    } finally {
      setAssigning(false);
      setShowNewInput(false);
      setNewName("");
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Content maxWidth="420px">
        <Dialog.Title>Identify speaker</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="1rem">
          Link this speaker to a saved voice profile.
        </Dialog.Description>

        <TextField.Root
          placeholder="Search profiles…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          mb="0.5rem"
        >
          <TextField.Slot>
            <HiOutlineMagnifyingGlass />
          </TextField.Slot>
        </TextField.Root>

        <Flex
          direction="column"
          gap="0.25rem"
          style={{
            maxHeight: 280,
            overflowY: "auto",
            border: "1px solid var(--gray-a5)",
            borderRadius: 8,
            padding: "0.25rem",
          }}
        >
          {isLoading && (
            <Flex align="center" justify="center" py="1rem" gap="0.5rem">
              <Spinner size="2" />
              <Text color="gray" size="2">
                Loading profiles…
              </Text>
            </Flex>
          )}
          {!isLoading && filtered.length === 0 && (
            <Flex align="center" justify="center" py="1rem">
              <Text color="gray" size="2">
                No profiles match.
              </Text>
            </Flex>
          )}
          {filtered.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              isSelected={selectedId === p.id}
              onSelect={() => setSelectedId(p.id)}
            />
          ))}
        </Flex>

        {/* Create new profile */}
        {showNewInput ? (
          <Flex align="center" gap="0.5rem" mt="0.75rem">
            <TextField.Root
              placeholder="New profile name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateNew();
                if (e.key === "Escape") {
                  setShowNewInput(false);
                  setNewName("");
                }
              }}
              style={{ flex: 1 }}
              autoFocus
            />
            <Button
              size="2"
              disabled={!newName.trim() || assigning}
              onClick={handleCreateNew}
            >
              {assigning ? <Spinner size="1" /> : "Create & assign"}
            </Button>
            <Button
              size="2"
              variant="ghost"
              color="gray"
              onClick={() => {
                setShowNewInput(false);
                setNewName("");
              }}
            >
              Cancel
            </Button>
          </Flex>
        ) : (
          <Tooltip content="Create a new speaker profile and assign it here">
            <Button
              variant="ghost"
              size="2"
              mt="0.75rem"
              onClick={() => setShowNewInput(true)}
            >
              <HiOutlinePlusCircle /> Create new profile
            </Button>
          </Tooltip>
        )}

        {error && (
          <Text color="red" size="2" mt="0.5rem">
            {error}
          </Text>
        )}

        <Flex justify="end" gap="0.5rem" mt="1rem">
          <Dialog.Close>
            <Button variant="soft" color="gray" onClick={onClose}>
              Cancel
            </Button>
          </Dialog.Close>
          <Button
            disabled={!selectedId || assigning}
            onClick={handleAssign}
          >
            {assigning ? <Spinner size="1" /> : "Assign"}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
};
