import { FC, useCallback, useRef, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Flex,
  Heading,
  IconButton,
  Separator,
  Spinner,
  Text,
  TextField,
  Tooltip,
} from "@radix-ui/themes";
import {
  HiArrowLeft,
  HiArrowTopRightOnSquare,
  HiOutlinePencil,
  HiOutlinePlusCircle,
  HiOutlineTrash,
  HiOutlineXMark,
} from "react-icons/hi2";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SpeakerProfile, RecordingMeta } from "../../types";
import { speakerProfilesApi, historyApi } from "../api";
import { QueryKeys } from "../../query-keys";

const getInitials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

/** Return all recordings where this profile appears (as [recordingId, meta] pairs). */
function recordingsForProfile(
  allRecordings: Record<string, RecordingMeta>,
  profileId: string,
): Array<{ id: string; meta: RecordingMeta; matchType: "auto" | "manual" | "suggested" }> {
  return Object.entries(allRecordings)
    .flatMap(([id, meta]) => {
      const matches = meta.speakerMatches ?? {};
      for (const match of Object.values(matches)) {
        if (match.profileId === profileId) {
          const matchType: "auto" | "manual" | "suggested" = match.matched
            ? match.confidence === 1.0
              ? "manual"
              : "auto"
            : "suggested";
          return [{ id, meta, matchType }];
        }
      }
      return [];
    })
    .sort((a, b) => b.meta.started.localeCompare(a.meta.started));
}

export const SpeakerProfileDetail: FC<{
  profile: SpeakerProfile;
  avatarUrl: string | null;
  allRecordings: Record<string, RecordingMeta>;
  onBack: () => void;
  onAvatarChange?: (newUrl: string | null) => void;
}> = ({ profile, avatarUrl, allRecordings, onBack, onAvatarChange }) => {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState(profile.name);
  const [newAlias, setNewAlias] = useState("");
  const [addingAlias, setAddingAlias] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const recordings = recordingsForProfile(allRecordings, profile.id);

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: [QueryKeys.SpeakerProfiles] });
    qc.invalidateQueries({ queryKey: [QueryKeys.History] });
  }, [qc]);

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      speakerProfilesApi.rename(id, name),
    onSuccess: () => {
      invalidate();
      setEditingName(false);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => speakerProfilesApi.remove(id),
    onSuccess: () => {
      invalidate();
      onBack();
    },
  });

  const setAvatarMutation = useMutation({
    mutationFn: ({ profileId, imageDataUrl }: { profileId: string; imageDataUrl: string }) =>
      speakerProfilesApi.setSpeakerAvatar(profileId, imageDataUrl),
    onSuccess: async (updatedProfile) => {
      invalidate();
      if (updatedProfile?.id) {
        const p = await speakerProfilesApi.getSpeakerAvatarPath(updatedProfile.id);
        onAvatarChange?.(p ? `file://${p}` : null);
      }
    },
  });

  const deleteAvatarMutation = useMutation({
    mutationFn: (profileId: string) => speakerProfilesApi.deleteSpeakerAvatar(profileId),
    onSuccess: () => {
      invalidate();
      onAvatarChange?.(null);
    },
  });

  const updateAliasesMutation = useMutation({
    mutationFn: ({ id, aliases }: { id: string; aliases: string[] }) =>
      speakerProfilesApi.updateAliases(id, aliases),
    onSuccess: () => invalidate(),
  });

  const handleAvatarFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        if (dataUrl) {
          setAvatarMutation.mutate({ profileId: profile.id, imageDataUrl: dataUrl });
        }
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    },
    [profile.id, setAvatarMutation],
  );

  const handleAddAlias = useCallback(async () => {
    const alias = newAlias.trim();
    if (!alias) return;
    const updatedAliases = [...(profile.aliases ?? []), alias];
    await updateAliasesMutation.mutateAsync({ id: profile.id, aliases: updatedAliases });
    setNewAlias("");
    setAddingAlias(false);
  }, [newAlias, profile.id, profile.aliases, updateAliasesMutation]);

  const handleRemoveAlias = useCallback(
    async (alias: string) => {
      const updatedAliases = (profile.aliases ?? []).filter((a) => a !== alias);
      await updateAliasesMutation.mutateAsync({ id: profile.id, aliases: updatedAliases });
    },
    [profile.id, profile.aliases, updateAliasesMutation],
  );

  return (
    <Flex direction="column" gap="1.25rem" p="1.5rem" style={{ height: "100%", overflowY: "auto" }}>
      {/* Back button */}
      <Flex align="center" gap="0.5rem">
        <IconButton variant="ghost" color="gray" onClick={onBack} aria-label="Back to directory">
          <HiArrowLeft />
        </IconButton>
        <Text color="gray" size="2">Speakers</Text>
      </Flex>

      {/* Avatar + name */}
      <Flex align="center" gap="1.5rem">
        <Tooltip content="Click to change avatar">
          <div
            style={{ cursor: "pointer" }}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Change avatar"
          >
            <Avatar
              size="6"
              fallback={getInitials(profile.name) || "?"}
              src={avatarUrl ?? undefined}
              style={{ display: "block" }}
            />
          </div>
        </Tooltip>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={handleAvatarFileChange}
        />
        <Flex direction="column" gap="0.25rem">
          {editingName ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                renameMutation.mutate({ id: profile.id, name: newName.trim() || profile.name });
              }}
            >
              <Flex align="center" gap="0.5rem">
                <TextField.Root
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Escape") setEditingName(false); }}
                />
                <Button type="submit" size="2" disabled={renameMutation.isPending}>
                  {renameMutation.isPending ? <Spinner size="1" /> : "Save"}
                </Button>
                <Button type="button" size="2" variant="ghost" color="gray" onClick={() => setEditingName(false)}>
                  Cancel
                </Button>
              </Flex>
            </form>
          ) : (
            <Flex align="center" gap="0.5rem">
              <Heading size="5">{profile.name}</Heading>
              <IconButton
                variant="ghost"
                size="1"
                aria-label="Edit name"
                onClick={() => { setEditingName(true); setNewName(profile.name); }}
              >
                <HiOutlinePencil />
              </IconButton>
            </Flex>
          )}
          {avatarUrl && (
            <Button
              variant="ghost"
              size="1"
              color="red"
              onClick={() => deleteAvatarMutation.mutate(profile.id)}
              disabled={deleteAvatarMutation.isPending}
            >
              Remove avatar
            </Button>
          )}
        </Flex>
      </Flex>

      <Separator size="4" />

      {/* Aliases */}
      <Flex direction="column" gap="0.5rem">
        <Text weight="medium">Aliases</Text>
        <Flex gap="0.5rem" wrap="wrap">
          {(profile.aliases ?? []).map((alias) => (
            <Badge key={alias} color="gray" style={{ gap: 4 }}>
              {alias}
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                aria-label={`Remove alias ${alias}`}
                style={{ height: "auto", minWidth: "auto", padding: 0 }}
                onClick={() => handleRemoveAlias(alias)}
              >
                <HiOutlineXMark style={{ fontSize: 10 }} />
              </IconButton>
            </Badge>
          ))}
          {(profile.aliases ?? []).length === 0 && (
            <Text size="2" color="gray">No aliases.</Text>
          )}
        </Flex>
        {addingAlias ? (
          <Flex align="center" gap="0.5rem">
            <TextField.Root
              placeholder="New alias…"
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddAlias();
                if (e.key === "Escape") { setAddingAlias(false); setNewAlias(""); }
              }}
              autoFocus
            />
            <Button size="2" onClick={handleAddAlias} disabled={!newAlias.trim()}>
              Add
            </Button>
            <Button size="2" variant="ghost" color="gray" onClick={() => { setAddingAlias(false); setNewAlias(""); }}>
              Cancel
            </Button>
          </Flex>
        ) : (
          <Button variant="ghost" size="2" style={{ alignSelf: "flex-start" }} onClick={() => setAddingAlias(true)}>
            <HiOutlinePlusCircle /> Add alias
          </Button>
        )}
      </Flex>

      <Separator size="4" />

      {/* Recordings */}
      <Flex direction="column" gap="0.5rem">
        <Text weight="medium">Recordings ({recordings.length})</Text>
        {recordings.length === 0 && (
          <Text size="2" color="gray">This speaker hasn&apos;t been matched to any recordings yet.</Text>
        )}
        {recordings.map(({ id, meta, matchType }) => (
          <Flex
            key={id}
            align="center"
            justify="between"
            gap="0.5rem"
            px="0.75rem"
            py="0.5rem"
            style={{
              border: "1px solid var(--gray-a4)",
              borderRadius: 6,
              background: "var(--color-panel)",
            }}
          >
            <Flex direction="column" gap="0.1rem">
              <Button
                variant="ghost"
                size="2"
                style={{ justifyContent: "flex-start", fontWeight: 500, paddingLeft: 0 }}
                onClick={() => historyApi.openRecordingDetailsWindow(id)}
              >
                <HiArrowTopRightOnSquare style={{ flexShrink: 0 }} />
                {meta.name ?? new Date(meta.started).toLocaleString()}
              </Button>
              <Text size="1" color="gray">
                {new Date(meta.started).toLocaleDateString()}
              </Text>
            </Flex>
            <Badge
              color={matchType === "manual" ? "jade" : matchType === "auto" ? "blue" : "amber"}
              size="1"
            >
              {matchType}
            </Badge>
          </Flex>
        ))}
      </Flex>

      <Separator size="4" />

      {/* Danger zone */}
      <Flex gap="0.75rem">
        <Button
          color="red"
          variant="soft"
          onClick={() => setConfirmDelete(true)}
        >
          <HiOutlineTrash /> Delete profile
        </Button>
      </Flex>

      {/* Delete confirmation dialog */}
      <Dialog.Root open={confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}>
        <Dialog.Content maxWidth="360px">
          <Dialog.Title>Delete profile</Dialog.Title>
          <Dialog.Description size="2" color="gray">
            Delete &ldquo;{profile.name}&rdquo;? This cannot be undone. Existing recording matches will remain but won&apos;t resolve to a profile.
          </Dialog.Description>
          <Flex justify="end" gap="0.5rem" mt="1rem">
            <Dialog.Close>
              <Button variant="soft" color="gray">Cancel</Button>
            </Dialog.Close>
            <Button
              color="red"
              onClick={() => removeMutation.mutate(profile.id)}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending ? <Spinner size="1" /> : "Delete"}
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Flex>
  );
};
