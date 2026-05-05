import { FC } from "react";
import { Button, Flex, Heading, Spinner, Text } from "@radix-ui/themes";
import {
  HiOutlineArrowPath,
  HiOutlineBars3,
  HiOutlineCheckCircle,
  HiOutlineEllipsisHorizontalCircle,
  HiOutlineExclamationTriangle,
  HiOutlineXCircle,
  HiOutlineXMark,
} from "react-icons/hi2";
import { ProgressStep } from "./progress-step";
import { useHistoryRecordings } from "../history/state";
import { ProgressCardWrapper } from "./progress-card-wrapper";
import { PostProcessingJob } from "../../types";
import { historyApi } from "../api";
import type { getProgressData } from "../../main/domain/postprocess";

const allSteps = [
  "wav",
  "mp3",
  "modelDownload",
  "whisper",
  "summary",
  "datahooks",
] as const;
const stepLabels = {
  modelDownload: "Downloading model",
  wav: "Preparing audio",
  mp3: "Generating MP3 file",
  whisper: "Transcribing audio",
  summary: "Generating summary",
  datahooks: "Running datahooks",
};

const RemoveButton: FC<{ id: string; label?: string }> = ({
  id,
  label = "Remove",
}) => (
  <Button
    size="1"
    variant="ghost"
    color="gray"
    onClick={() => historyApi.removeFromPostProcessingQueue(id)}
  >
    <HiOutlineXMark /> {label}
  </Button>
);

const RetryButton: FC<{ id: string }> = ({ id }) => (
  <Button
    size="1"
    variant="soft"
    color="amber"
    onClick={() => historyApi.retryPostProcessingItem(id)}
  >
    <HiOutlineArrowPath /> Retry
  </Button>
);

const CancelButton: FC<{ id: string }> = ({ id }) => (
  <Button
    size="1"
    variant="soft"
    color="red"
    onClick={() => historyApi.cancelPostProcessingItem(id)}
  >
    <HiOutlineXMark /> Cancel
  </Button>
);

export const ProgressCard: FC<{
  job: PostProcessingJob;
  data: Awaited<ReturnType<typeof getProgressData>>;
}> = ({ job, data }) => {
  const { data: recordings } = useHistoryRecordings();
  const recording = recordings?.[job.recordingId];
  const name = recording?.name ?? "Untitled recording";

  switch (job.status) {
    case "failed":
      return (
        <ProgressCardWrapper
          header={<Text color="red">{name}</Text>}
          icon={<HiOutlineExclamationTriangle color="var(--red-11)" />}
          actions={
            <Flex gap=".25rem">
              <RetryButton id={job.id} />
              <RemoveButton id={job.id} />
            </Flex>
          }
        >
          {job.error && (
            <pre
              style={{
                overflowX: "auto",
                overflowY: "auto",
                maxHeight: "400px",
              }}
            >
              {job.error}
            </pre>
          )}
        </ProgressCardWrapper>
      );

    case "cancelled":
      return (
        <ProgressCardWrapper
          header={<Text color="gray">{name}</Text>}
          icon={<HiOutlineXCircle color="var(--gray-11)" />}
          actions={
            <Flex gap=".25rem">
              <RetryButton id={job.id} />
              <RemoveButton id={job.id} />
            </Flex>
          }
        />
      );

    case "done":
      return (
        <ProgressCardWrapper
          header={<Text color="green">{name}</Text>}
          icon={<HiOutlineCheckCircle color="var(--green-11)" />}
          actions={<RemoveButton id={job.id} />}
        />
      );

    case "processing":
      return (
        <ProgressCardWrapper
          icon={<Spinner size="3" />}
          header={
            <>
              <Heading>{name}</Heading>
              <Text>File is processing...</Text>
            </>
          }
          actions={<CancelButton id={job.id} />}
        >
          {allSteps
            .filter((step) => !job.steps || job.steps.includes(step))
            .map((item, index) => (
              <ProgressStep
                key={item}
                label={stepLabels[item]}
                isRunning={item === data.currentStep}
                isDone={allSteps.indexOf(data.currentStep as any) > index}
                progress={data.progress[item]}
              />
            ))}
        </ProgressCardWrapper>
      );

    case "queued":
    default:
      return (
        <ProgressCardWrapper
          icon={<HiOutlineEllipsisHorizontalCircle />}
          header={<Text>{name}</Text>}
          actions={
            <Flex gap=".25rem" align="center">
              <RemoveButton id={job.id} />
              <span
                aria-label="Drag to reorder"
                title="Drag to reorder"
                style={{ cursor: "grab", color: "var(--gray-9)" }}
              >
                <HiOutlineBars3 />
              </span>
            </Flex>
          }
        />
      );
  }
};
