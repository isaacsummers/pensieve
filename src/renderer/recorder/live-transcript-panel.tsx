import { FC, useEffect, useRef } from "react";
import { Badge, Box, Flex, ScrollArea, Spinner, Text } from "@radix-ui/themes";
import { useLiveTranscriptionState, useLiveTranscriptionEvents } from "./live-transcription-state";

/**
 * Live transcript panel displayed during an active recording session
 * when live transcription is enabled.
 *
 * Shows fragments as they stream in from the Python sidecar with auto-scroll.
 */
export const LiveTranscriptPanel: FC = () => {
  // Subscribe to push events from the main process
  useLiveTranscriptionEvents();

  const { status, fragments, isEnabled } = useLiveTranscriptionState();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the bottom whenever new fragments arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [fragments.length]);

  if (!isEnabled) return null;

  return (
    <Box
      style={{
        border: "1px solid var(--gray-5)",
        borderRadius: "var(--radius-3)",
        background: "var(--gray-2)",
        minHeight: "6rem",
        maxHeight: "12rem",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <Flex
        align="center"
        gap="2"
        px="3"
        py="1"
        style={{
          borderBottom: "1px solid var(--gray-4)",
          background: "var(--gray-3)",
        }}
      >
        {status === "loading" && (
          <>
            <Spinner size="1" />
            <Text size="1" color="gray">
              Loading transcription model…
            </Text>
          </>
        )}
        {status === "active" && (
          <>
            <Badge color="green" size="1">
              LIVE
            </Badge>
            <Text size="1" color="gray">
              Live transcript
            </Text>
          </>
        )}
        {status === "finalizing" && (
          <>
            <Spinner size="1" />
            <Text size="1" color="gray">
              Finalizing transcript…
            </Text>
          </>
        )}
        {status === "idle" && (
          <Text size="1" color="gray">
            Live transcript (idle)
          </Text>
        )}
        {status === "error" && (
          <Text size="1" color="red">
            Transcription error
          </Text>
        )}
      </Flex>

      {/* Fragment list */}
      <ScrollArea style={{ flexGrow: 1 }}>
        <Box px="3" py="2">
          {fragments.length === 0 && status === "active" && (
            <Text size="2" color="gray">
              Listening…
            </Text>
          )}
          {fragments.map((f) => (
            <Text
              key={f.seq}
              size="2"
              as="p"
              style={{ marginBottom: "0.25rem" }}
            >
              {f.text}
            </Text>
          ))}
          <div ref={bottomRef} />
        </Box>
      </ScrollArea>
    </Box>
  );
};
