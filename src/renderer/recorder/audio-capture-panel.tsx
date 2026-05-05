import { FC, useMemo, useState } from "react";
import { Box, Flex, IconButton, Select, Text } from "@radix-ui/themes";
import { HiChevronDown, HiChevronRight } from "react-icons/hi2";
import { useRecorderState } from "./state";
import { useAudioOutputSources, useMicSources } from "./hooks";

/**
 * Two-section audio capture configuration panel.
 *
 * Section 1 — Microphone (optional):
 *   A checkbox controls whether a primary mic is captured. When enabled, a
 *   device selector appears. Disabling sets `mic` to `undefined` in config.
 *
 * Section 2 — Additional audio capture (independent of mic):
 *   Always available regardless of mic state. Collapsed by default unless
 *   devices are already selected. Contains two subsections for microphone
 *   inputs and audio outputs / virtual devices.
 *
 * Replaces the legacy `MicMultiSelector` which incorrectly tied additional
 * device availability to whether a primary mic was selected.
 */
export const AudioCapturePanel: FC = () => {
  const audioInputs = useMicSources();
  const audioOutputs = useAudioOutputSources();
  const { setConfig, recordingConfig } = useRecorderState();
  const additional = recordingConfig.additionalAudioDevices ?? [];

  const [expanded, setExpanded] = useState(additional.length > 0);
  const [showInputs, setShowInputs] = useState(true);
  const [showOutputs, setShowOutputs] = useState(true);

  const micEnabled = !!recordingConfig.mic;

  const handleMicToggle = (enabled: boolean) => {
    if (enabled) {
      // Select the first available input as default when enabling.
      const mic = audioInputs?.[0];
      setConfig({ mic });
    } else {
      setConfig({ mic: undefined });
    }
  };

  const additionalIds = useMemo(
    () => new Set(additional.map((d) => d.deviceId)),
    [additional],
  );

  const toggleAdditional = (device: MediaDeviceInfo) => {
    const next = additionalIds.has(device.deviceId)
      ? additional.filter((d) => d.deviceId !== device.deviceId)
      : [...additional, device];
    setConfig({ additionalAudioDevices: next });
  };

  // Exclude the primary mic from the additional inputs list to avoid duplication.
  // When mic is undefined the filter is a no-op and all inputs are shown.
  const selectableInputs = (audioInputs ?? []).filter(
    (d) => d.deviceId !== recordingConfig.mic?.deviceId,
  );

  return (
    <Flex direction="column" gap=".75rem">
      {/* ── Section 1: Microphone (optional) ── */}
      <Box>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: ".5rem",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <input
            type="checkbox"
            checked={micEnabled}
            onChange={(e) => handleMicToggle(e.target.checked)}
          />
          <Text size="2" weight="bold">
            Microphone
          </Text>
        </label>

        {micEnabled && (
          <Box mt=".5rem">
            <Select.Root
              value={recordingConfig.mic?.deviceId}
              onValueChange={(value) => {
                const mic = audioInputs?.find((s) => s.deviceId === value);
                if (!mic) return;
                // If the new primary was in additional devices, drop the dup.
                const cleaned = additional.filter((d) => d.deviceId !== value);
                setConfig({ mic, additionalAudioDevices: cleaned });
              }}
            >
              <Select.Trigger
                style={{
                  maxWidth: "-webkit-fill-available",
                  minWidth: "-webkit-fill-available",
                }}
                placeholder="Select microphone"
              />
              <Select.Content position="popper" style={{ maxWidth: "100%" }}>
                {audioInputs?.map((source) => (
                  <Select.Item value={source.deviceId} key={source.deviceId}>
                    {source.label || source.deviceId}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Box>
        )}
      </Box>

      {/* ── Section 2: Additional audio capture (independent of mic) ── */}
      <Box>
        <Flex
          align="center"
          gap=".25rem"
          style={{ cursor: "pointer", userSelect: "none" }}
          onClick={() => setExpanded((v) => !v)}
        >
          <IconButton
            variant="ghost"
            size="1"
            aria-label="Toggle additional audio capture"
          >
            {expanded ? <HiChevronDown /> : <HiChevronRight />}
          </IconButton>
          <Text size="1">
            {`Additional audio capture${additional.length > 0 ? ` (${additional.length})` : ""}`}
          </Text>
        </Flex>

        {expanded && (
          <Flex direction="column" gap=".5rem" pl="1rem" mt=".5rem">
            {/* Microphone inputs subsection */}
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
                        onChange={() => toggleAdditional(device)}
                      />
                      <Text size="1">{device.label || device.deviceId}</Text>
                    </label>
                  ))}
                </Flex>
              )}
            </Box>

            {/* Audio outputs / virtual devices subsection */}
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
                        onChange={() => toggleAdditional(device)}
                      />
                      <Text size="1">{device.label || device.deviceId}</Text>
                    </label>
                  ))}
                </Flex>
              )}
            </Box>
          </Flex>
        )}
      </Box>
    </Flex>
  );
};
