import { FC, useMemo, useState } from "react";
import { Box, Flex, IconButton, Select, Text } from "@radix-ui/themes";
import { HiChevronDown, HiChevronRight } from "react-icons/hi2";
import { useRecorderState } from "./state";
import { useAudioOutputSources, useMicSources } from "./hooks";

/**
 * Replaces the legacy single-device `MicSelector`. Lets the user pick a
 * primary mic (audio input) plus any number of additional audio devices,
 * including audio outputs (e.g. SteelSeries Sonar's virtual Gaming/Chat/
 * Media channels). Additional devices are collapsed by default.
 */
export const MicMultiSelector: FC = () => {
  const audioInputs = useMicSources();
  const audioOutputs = useAudioOutputSources();
  const { setConfig, recordingConfig } = useRecorderState();
  const additional = recordingConfig.additionalAudioDevices ?? [];

  const [expanded, setExpanded] = useState(additional.length > 0);
  const [showInputs, setShowInputs] = useState(true);
  const [showOutputs, setShowOutputs] = useState(true);

  const additionalIds = useMemo(
    () => new Set(additional.map((d) => d.deviceId)),
    [additional],
  );

  const toggle = (device: MediaDeviceInfo) => {
    const next = additionalIds.has(device.deviceId)
      ? additional.filter((d) => d.deviceId !== device.deviceId)
      : [...additional, device];
    setConfig({ additionalAudioDevices: next });
  };

  const selectableInputs = (audioInputs ?? []).filter(
    (d) => d.deviceId !== recordingConfig.mic?.deviceId,
  );

  return (
    <Flex direction="column" gap=".5rem">
      <Select.Root
        value={recordingConfig.mic?.deviceId}
        onValueChange={(value) => {
          const mic = audioInputs?.find((s) => s.deviceId === value);
          if (!mic) return;
          // Selecting a primary that is also in additional drops the dup.
          const cleaned = additional.filter((d) => d.deviceId !== value);
          setConfig({ mic, additionalAudioDevices: cleaned });
        }}
        disabled={!recordingConfig.mic}
      >
        <Select.Trigger
          style={{
            maxWidth: "-webkit-fill-available",
            minWidth: "-webkit-fill-available",
          }}
          placeholder="Microphone"
        />
        <Select.Content position="popper" style={{ maxWidth: "100%" }}>
          {audioInputs?.map((source) => (
            <Select.Item value={source.deviceId} key={source.deviceId}>
              {source.label || source.deviceId}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>

      <Flex
        align="center"
        gap=".25rem"
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => setExpanded((v) => !v)}
      >
        <IconButton
          variant="ghost"
          size="1"
          aria-label="Toggle additional inputs"
        >
          {expanded ? <HiChevronDown /> : <HiChevronRight />}
        </IconButton>
        <Text size="1">
          {expanded
            ? "Additional audio devices"
            : `Add more inputs${
                additional.length > 0 ? ` (${additional.length})` : ""
              }`}
        </Text>
      </Flex>

      {expanded && (
        <Flex direction="column" gap=".5rem" pl="1rem">
          <Box>
            <Flex
              align="center"
              gap=".25rem"
              style={{ cursor: "pointer", userSelect: "none" }}
              onClick={() => setShowInputs((v) => !v)}
            >
              <IconButton
                variant="ghost"
                size="1"
                aria-label="Toggle microphone inputs"
              >
                {showInputs ? <HiChevronDown /> : <HiChevronRight />}
              </IconButton>
              <Text size="1" weight="bold">
                Microphone inputs
              </Text>
            </Flex>
            {showInputs && (
              <Flex direction="column" gap=".25rem" pl="1.5rem" mt=".25rem">
                {selectableInputs.length === 0 && (
                  <Text size="1" color="gray">
                    No additional inputs available.
                  </Text>
                )}
                {selectableInputs.map((device) => (
                  <label
                    key={device.deviceId}
                    style={{
                      display: "flex",
                      gap: ".5rem",
                      alignItems: "center",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={additionalIds.has(device.deviceId)}
                      onChange={() => toggle(device)}
                      disabled={!recordingConfig.mic}
                    />
                    <Text size="1">{device.label || device.deviceId}</Text>
                  </label>
                ))}
              </Flex>
            )}
          </Box>

          <Box>
            <Flex
              align="center"
              gap=".25rem"
              style={{ cursor: "pointer", userSelect: "none" }}
              onClick={() => setShowOutputs((v) => !v)}
            >
              <IconButton
                variant="ghost"
                size="1"
                aria-label="Toggle audio outputs"
              >
                {showOutputs ? <HiChevronDown /> : <HiChevronRight />}
              </IconButton>
              <Text size="1" weight="bold">
                Audio outputs / virtual devices
              </Text>
            </Flex>
            {showOutputs && (
              <Flex direction="column" gap=".25rem" pl="1.5rem" mt=".25rem">
                {(audioOutputs ?? []).length === 0 && (
                  <Text size="1" color="gray">
                    No output devices detected.
                  </Text>
                )}
                {(audioOutputs ?? []).map((device) => (
                  <label
                    key={device.deviceId}
                    style={{
                      display: "flex",
                      gap: ".5rem",
                      alignItems: "center",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={additionalIds.has(device.deviceId)}
                      onChange={() => toggle(device)}
                      disabled={!recordingConfig.mic}
                    />
                    <Text size="1">{device.label || device.deviceId}</Text>
                  </label>
                ))}
                <Text size="1" color="gray">
                  Note: capture of plain output devices is best-effort. True
                  loopback requires WASAPI; unsupported devices will be
                  skipped at record time. Stereo channel separation per
                  device is future work.
                </Text>
              </Flex>
            )}
          </Box>
        </Flex>
      )}
    </Flex>
  );
};
