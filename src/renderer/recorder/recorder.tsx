import {
  Box,
  Button,
  CheckboxCards,
  Flex,
  Text,
  TextField,
} from "@radix-ui/themes";

import { forwardRef, useEffect } from "react";
import { useRecorderState } from "./state";
import { AudioCapturePanel } from "./audio-capture-panel";
import { RecorderInsession } from "./recorder-insession";

export const Recorder = forwardRef<HTMLDivElement>((_, ref) => {
  const {
    setConfig,
    recordingConfig,
    startRecording,
    recorder,
    meta,
    setMeta,
    hydrateFromSettings,
  } = useRecorderState();

  // Restore persisted recording settings on first mount. Cheap, idempotent.
  useEffect(() => {
    hydrateFromSettings();
  }, [hydrateFromSettings]);

  if (recorder) {
    return <RecorderInsession ref={ref} />;
  }

  return (
    <Flex direction="column" px=".5rem" py="1rem" gap=".5rem" ref={ref}>
      {/* <button
        onClick={() => {
          windowsApi.openRecorderOverlayWindow();
        }}
      >
        Overlay
      </button> */}
      {/* <DatePicker
        label="Appointment date"
        // minValue={today(getLocalTimeZone())}
      /> */}
      <TextField.Root
        size="2"
        placeholder="Untitled Recording"
        value={meta?.name ?? ""}
        onChange={(e) => {
          setMeta({ name: e.currentTarget.value });
        }}
      />

      <CheckboxCards.Root
        value={[recordingConfig.recordScreenAudio ? "screen" : ""]}
        columns={{ initial: "1" }}
        onValueChange={(value) => {
          setConfig({ recordScreenAudio: value.includes("screen") });
        }}
      >
        <CheckboxCards.Item value="screen">
          <Flex direction="column" width="100%">
            <Text weight="bold">Record screen audio</Text>
          </Flex>
        </CheckboxCards.Item>
      </CheckboxCards.Root>

      <Box mt="1rem">
        <AudioCapturePanel />
      </Box>

      <Flex justify="center">
        <Button
          onClick={startRecording}
          size="3"
          mt="1rem"
          style={{ width: "200px" }}
        >
          Start recording
        </Button>
      </Flex>
    </Flex>
  );
});
