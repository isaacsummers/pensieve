/**
 * TranscriptVersionBar — shown above the transcript in the recording detail view.
 *
 * Features:
 *  - Version selector (hidden when only one version exists)
 *  - Re-process button with model selector
 *  - Currently active version info badge
 */
import { FC, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  Select,
  Spinner,
  Text,
} from "@radix-ui/themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HiArrowPath } from "react-icons/hi2";
import { QueryKeys } from "../../query-keys";
import { historyApi } from "../api";
import { TranscriptVersionSummary } from "../../types";

const REPROCESS_MODELS = [
  { value: "base.en", label: "base.en" },
  { value: "small", label: "small" },
  { value: "medium", label: "medium" },
  { value: "large-v3", label: "large-v3 (slow)" },
];

const VERSION_KIND_LABEL: Record<string, string> = {
  live: "Live",
  batch: "Batch",
};

type Props = {
  recordingId: string;
  activeVersionId?: string;
  onVersionChange?: () => void;
};

export const TranscriptVersionBar: FC<Props> = ({
  recordingId,
  activeVersionId,
  onVersionChange,
}) => {
  const qc = useQueryClient();
  const [reprocessModel, setReprocessModel] = useState("large-v3");

  const { data: versions } = useQuery({
    queryKey: [QueryKeys.Transcript, recordingId, "versions"],
    queryFn: () => historyApi.listTranscriptVersions(recordingId),
  });

  const setActive = useMutation({
    mutationFn: (versionId: string) =>
      historyApi.setActiveTranscriptVersion(recordingId, versionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QueryKeys.Transcript, recordingId] });
      qc.invalidateQueries({ queryKey: [QueryKeys.History, recordingId] });
      onVersionChange?.();
    },
  });

  const reprocess = useMutation({
    mutationFn: (model: string) =>
      historyApi.reprocessWithModel(recordingId, model),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QueryKeys.PostProcessing] });
    },
  });

  if (!versions) return null;

  // Determine the active version summary
  const activeVersion =
    versions.find((v) => v.id === activeVersionId) ?? versions[0];

  return (
    <Flex
      align="center"
      gap="2"
      px="3"
      py="2"
      wrap="wrap"
      style={{
        borderBottom: "1px solid var(--gray-4)",
        background: "var(--gray-2)",
        fontSize: "var(--font-size-1)",
      }}
    >
      {/* Active version info */}
      {activeVersion && (
        <Flex align="center" gap="1">
          <Badge
            color={activeVersion.kind === "live" ? "green" : "blue"}
            size="1"
            variant="soft"
          >
            {VERSION_KIND_LABEL[activeVersion.kind] ?? activeVersion.kind}
          </Badge>
          <Text size="1" color="gray">
            {activeVersion.model}
          </Text>
          <Text size="1" color="gray">
            ·
          </Text>
          <Text size="1" color="gray">
            {activeVersion.itemCount} segments
          </Text>
        </Flex>
      )}

      {/* Version selector — only when multiple versions exist */}
      {versions.length > 1 && (
        <Select.Root
          size="1"
          value={activeVersionId ?? versions[0]?.id}
          onValueChange={(id) => setActive.mutate(id)}
        >
          <Select.Trigger placeholder="Select version" />
          <Select.Content>
            {versions.map((v) => (
              <Select.Item key={v.id} value={v.id}>
                {VERSION_KIND_LABEL[v.kind] ?? v.kind} · {v.model} ·{" "}
                {new Date(v.createdAt).toLocaleString()}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      )}

      {/* Spacer */}
      <Box flexGrow="1" />

      {/* Re-process controls */}
      <Flex align="center" gap="1">
        <Select.Root
          size="1"
          value={reprocessModel}
          onValueChange={setReprocessModel}
        >
          <Select.Trigger />
          <Select.Content>
            {REPROCESS_MODELS.map((m) => (
              <Select.Item key={m.value} value={m.value}>
                {m.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <Button
          size="1"
          variant="soft"
          onClick={() => reprocess.mutate(reprocessModel)}
          disabled={reprocess.isPending}
        >
          {reprocess.isPending ? <Spinner size="1" /> : <HiArrowPath />}
          Re-process
        </Button>
      </Flex>
    </Flex>
  );
};
