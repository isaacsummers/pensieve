import { FC } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { Badge, Button, Callout, Flex, Heading, Text } from "@radix-ui/themes";
import { useFormContext } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { GoLinkExternal } from "react-icons/go";
import { HiOutlineCheckCircle, HiOutlineXCircle } from "react-icons/hi2";
import { modelData } from "../../model-data";
import { Settings } from "../../types";
import { QueryKeys } from "../../query-keys";
import { mainApi, whisperxApi } from "../api";
import { SettingsTextField } from "./settings-text-field";
import { SettingsSwitchField } from "./settings-switch-field";
import { SettingsSelectField } from "./settings-select-field";
import { SettingsTab } from "./tabs";
import { SettingsField } from "./settings-field";

export const WhisperSettings: FC = () => {
  const form = useFormContext<Settings>();

  const { data: availability } = useQuery({
    queryKey: [QueryKeys.HasModel],
    queryFn: whisperxApi.checkInstalled,
    refetchInterval: 5000,
  });

  return (
    <Tabs.Content value={SettingsTab.Whisper}>
      <Heading>Audio Transcription (WhisperX)</Heading>
      <Text as="p">
        Pensieve transcribes recordings using{" "}
        <a
          href="https://github.com/m-bain/whisperX"
          onClick={(e) => {
            e.preventDefault();
            mainApi.openWeb("https://github.com/m-bain/whisperX");
          }}
        >
          WhisperX
        </a>
        , which combines Faster-Whisper transcription, forced word alignment,
        and pyannote-based speaker diarization. WhisperX must be installed
        separately.
      </Text>

      {availability && (
        <Callout.Root
          mt="1rem"
          color={availability.ok ? "green" : "red"}
          variant="surface"
        >
          <Callout.Icon>
            {availability.ok ? <HiOutlineCheckCircle /> : <HiOutlineXCircle />}
          </Callout.Icon>
          <Callout.Text>
            {availability.ok
              ? `WhisperX detected${
                  availability.version ? ` (v${availability.version})` : ""
                }.`
              : `WhisperX is not available: ${
                  availability.error ?? "unknown error"
                }. Install with \`uv tool install whisperx\` (or pipx) and restart Pensieve.`}
          </Callout.Text>
        </Callout.Root>
      )}

      <Heading mt="2rem" size="4">
        Installation
      </Heading>
      <Text as="p">
        On Windows, install{" "}
        <a
          href="https://docs.astral.sh/uv/"
          onClick={(e) => {
            e.preventDefault();
            mainApi.openWeb("https://docs.astral.sh/uv/");
          }}
        >
          uv
        </a>{" "}
        and run <code>uv tool install whisperx</code>. On macOS / Linux,{" "}
        <code>pipx install whisperx</code> also works. For diarization, accept
        the terms at{" "}
        <a
          href="https://huggingface.co/pyannote/speaker-diarization-3.1"
          onClick={(e) => {
            e.preventDefault();
            mainApi.openWeb(
              "https://huggingface.co/pyannote/speaker-diarization-3.1",
            );
          }}
        >
          pyannote/speaker-diarization-3.1
        </a>{" "}
        and{" "}
        <a
          href="https://huggingface.co/pyannote/segmentation-3.0"
          onClick={(e) => {
            e.preventDefault();
            mainApi.openWeb("https://huggingface.co/pyannote/segmentation-3.0");
          }}
        >
          pyannote/segmentation-3.0
        </a>
        , then generate a read token under HF settings and paste it below.
      </Text>
      <Flex gap="0.5rem" mt="0.5rem">
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            mainApi.openWeb("https://github.com/m-bain/whisperX#readme")
          }
        >
          <GoLinkExternal /> WhisperX setup guide
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            mainApi.openWeb("https://huggingface.co/settings/tokens")
          }
        >
          <GoLinkExternal /> Hugging Face tokens
        </Button>
      </Flex>

      <Heading mt="2rem" size="4">
        Executable
      </Heading>
      <SettingsTextField
        {...form.register("whisperx.executable")}
        label="WhisperX executable"
        description="Command or absolute path. Leave as `whisperx` to resolve via PATH."
      />
      <SettingsTextField
        {...form.register("whisperx.pythonPath")}
        label="Python interpreter (optional)"
        description="If set, WhisperX is invoked as `<python> -m whisperx`. Useful when running inside a venv without exposing the CLI on PATH."
      />

      <Heading mt="2rem" size="4">
        Model
      </Heading>
      <Text as="p">
        WhisperX downloads and caches models on first use. Larger models are
        more accurate but use more memory and are slower without a GPU.
      </Text>
      <Flex mt="0.5rem" gap="0.3rem" wrap="wrap">
        {Object.values(modelData).map((model) => (
          <Badge
            key={model.name}
            color={
              form.watch("whisperx.model") === model.name ? "green" : "gray"
            }
          >
            {model.name}
          </Badge>
        ))}
      </Flex>
      <SettingsSelectField
        form={form}
        field="whisperx.model"
        label="Faster-Whisper model"
        description="Recommended: `large-v3` on GPU, `small` or `base` on CPU."
        values={Object.keys(modelData)}
      />
      <SettingsTextField
        {...form.register("whisperx.language")}
        label="Language"
        description='Spoken language, "auto" for auto-detection, or an ISO code like "en".'
      />

      <Heading mt="2rem" size="4">
        Compute
      </Heading>
      <SettingsSelectField
        form={form}
        field="whisperx.device"
        label="Device"
        description="`cuda` for NVIDIA GPUs, `cpu` for CPU-only, `mps` for Apple Silicon (experimental)."
        values={["cuda", "cpu", "mps"]}
      />
      <SettingsSelectField
        form={form}
        field="whisperx.computeType"
        label="Compute type"
        description="`float16` is fastest on NVIDIA GPUs; `int8` is the CPU-friendly fallback; `float32` is slowest and rarely needed."
        values={["float16", "int8", "float32"]}
      />
      <SettingsTextField
        {...form.register("whisperx.batchSize", { valueAsNumber: true })}
        label="Batch size"
        description="Reduce if you hit out-of-memory errors."
        type="number"
      />

      <Heading mt="2rem" size="4">
        Diarization
      </Heading>
      <SettingsSwitchField
        form={form}
        field="whisperx.diarize"
        label="Enable diarization"
        description="Assign speakers to each segment using pyannote. Requires a Hugging Face token."
      />
      <SettingsTextField
        {...form.register("whisperx.hfToken")}
        label="Hugging Face token"
        description="Read token from huggingface.co/settings/tokens. Only used locally to authenticate model downloads."
        type="password"
      />
      <SettingsTextField
        {...form.register("whisperx.minSpeakers", { valueAsNumber: true })}
        label="Min speakers"
        description="Lower bound for the diarizer. 0 to let pyannote decide."
        type="number"
      />
      <SettingsTextField
        {...form.register("whisperx.maxSpeakers", { valueAsNumber: true })}
        label="Max speakers"
        description="Upper bound for the diarizer. 0 to let pyannote decide."
        type="number"
      />
      <SettingsSelectField
        form={form}
        field="whisperx.vadMethod"
        label="VAD method"
        description="Voice-activity detector used before transcription."
        values={["silero", "pyannote"]}
      />

      <Heading mt="2rem" size="4">
        Other
      </Heading>
      <SettingsSwitchField
        form={form}
        field="whisperx.translate"
        label="Translate"
        description="Translate transcription from the source language to English."
      />
      <SettingsSwitchField
        form={form}
        field="whisperx.alignOutput"
        label="Force word alignment"
        description="Run the wav2vec alignment pass. Disable to save time if you do not need word-level timestamps."
      />

      <SettingsField
        label="Speaker profiles"
        description="Naming known speakers across recordings is planned for a future release (Phase 2). Current transcripts label speakers as `Speaker 0`, `Speaker 1`, ..."
      >
        <Badge color="amber">Coming soon</Badge>
      </SettingsField>
    </Tabs.Content>
  );
};
