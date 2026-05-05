import { DragEvent, FC, useMemo, useState } from "react";
import { Button, Flex, Text } from "@radix-ui/themes";
import { useQuery } from "@tanstack/react-query";
import { HiOutlineCheckCircle } from "react-icons/hi2";
import { ProgressCard } from "./progress-card";
import { QueryKeys } from "../../query-keys";
import { historyApi } from "../api";
import { EmptyState } from "../common/empty-state";
import { PostProcessingJob } from "../../types";

export const Postprocess: FC = () => {
  const { data } = useQuery({
    queryKey: [QueryKeys.PostProcessing],
    queryFn: historyApi.getPostProcessingProgress,
  });

  const counts = useMemo(() => {
    const queue = data?.processingQueue ?? [];
    return {
      failed: queue.filter(
        (j) => j.status === "failed" || j.status === "cancelled",
      ).length,
      done: queue.filter((j) => j.status === "done").length,
      pending: queue.filter(
        (j) => j.status === "queued" || j.status === "processing",
      ).length,
    };
  }, [data?.processingQueue]);

  const hasQueueCompleted = useMemo(
    () =>
      data?.processingQueue.every(
        (item) => item.status !== "queued" && item.status !== "processing",
      ),
    [data?.processingQueue],
  );

  if (!data) return null;

  if (data.processingQueue.length === 0) {
    return (
      <EmptyState
        title="Nothing to process"
        description="No sessions are queued for processing."
        icon={<HiOutlineCheckCircle size={32} />}
      />
    );
  }

  return (
    <Flex
      maxWidth="32rem"
      mx="auto"
      my="1rem"
      px="1rem"
      direction="column"
      gap="1rem"
    >
      <Flex align="center" gap=".5rem" wrap="wrap">
        <Text as="div" size="1" style={{ flexGrow: "1" }}>
          {data.isRunning
            ? "Sessions are being processed..."
            : hasQueueCompleted
              ? "Postprocessing is finished."
              : "Postprocessing was cancelled. You can start it again."}
        </Text>
        <Button
          onClick={() => historyApi.retryAllFailedPostProcessing()}
          variant="soft"
          color="amber"
          disabled={counts.failed === 0}
        >
          Retry all failed
        </Button>
        <Button
          onClick={() => historyApi.clearCompletedPostProcessing()}
          variant="soft"
          color="gray"
          disabled={counts.done === 0}
        >
          Clear completed
        </Button>
        <Button
          onClick={() => historyApi.clearPostProcessingQueue()}
          variant="soft"
          color="gray"
        >
          Clear all
        </Button>
        {data.isRunning && (
          <Button onClick={() => historyApi.stopPostProcessing()}>Stop</Button>
        )}
        {!data.isRunning && counts.pending > 0 && (
          <Button onClick={() => historyApi.startPostProcessing()}>
            Start
          </Button>
        )}
      </Flex>

      <QueueList queue={data.processingQueue} data={data} />
    </Flex>
  );
};

const QueueList: FC<{
  queue: PostProcessingJob[];
  data: NonNullable<
    Awaited<ReturnType<typeof historyApi.getPostProcessingProgress>>
  >;
}> = ({ queue, data }) => {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // Stable id key per item; sort by `order` for display.
  const sorted = useMemo(
    () => [...queue].sort((a, b) => a.order - b.order),
    [queue],
  );

  const onDragStart = (id: string, status: PostProcessingJob["status"]) => {
    if (status !== "queued") return;
    setDragId(id);
  };
  const onDragOver = (
    e: DragEvent,
    id: string,
    status: PostProcessingJob["status"],
  ) => {
    if (!dragId || dragId === id || status !== "queued") return;
    e.preventDefault();
    setOverId(id);
  };
  const onDrop = (
    e: DragEvent,
    id: string,
    status: PostProcessingJob["status"],
  ) => {
    if (!dragId || status !== "queued") return;
    e.preventDefault();
    // Drop *after* the target item.
    historyApi.reorderPostProcessingItem(dragId, id);
    setDragId(null);
    setOverId(null);
  };
  const onDragEnd = () => {
    setDragId(null);
    setOverId(null);
  };

  return (
    <Flex direction="column" gap="1rem">
      {sorted.map((job) => (
        <div
          key={job.id}
          draggable={job.status === "queued"}
          onDragStart={() => onDragStart(job.id, job.status)}
          onDragOver={(e) => onDragOver(e, job.id, job.status)}
          onDrop={(e) => onDrop(e, job.id, job.status)}
          onDragEnd={onDragEnd}
          style={{
            opacity: dragId === job.id ? 0.5 : 1,
            outline:
              overId === job.id && dragId && dragId !== job.id
                ? "2px dashed var(--accent-9)"
                : undefined,
            borderRadius: 6,
          }}
        >
          <ProgressCard data={data} job={job} />
        </div>
      ))}
    </Flex>
  );
};
