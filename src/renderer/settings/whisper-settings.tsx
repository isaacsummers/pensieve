import { FC, useEffect, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import {
  Badge,
  Button,
  Callout,
  Flex,
  Heading,
  IconButton,
  Spinner,
  Text,
} from "@radix-ui/themes";
import { useFormContext } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GoLinkExternal } from "react-icons/go";
import {
  HiOutlineCheckCircle,
  HiOutlineTrash,
  HiOutlineXCircle,
  HiPlay,
} from "react-icons/hi2";
import { modelData } from "../../model-data";
import { Settings } from "../../types";
import { QueryKeys } from "../../query-keys";
import { mainApi, speakerProfilesApi, whisperxApi } from "../api";
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
        Transcription pipeline
      </Heading>
      {/* eslint-disable-next-line @typescript-eslint/no-use-before-define */}
      <TestTranscriptionPanel />

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

      <SettingsField
        label="Speaker profiles"
        description="Rename a speaker on any recording to save them as a reusable voice profile. Future transcriptions will be auto-labeled when the voice matches."
      >
        <Text color="gray" size="2">
          Manage profiles in the panel below.
        </Text>
      </SettingsField>

      <Heading mt="2rem" size="4">
        Voice embedding pipeline
      </Heading>
      <Text as="p">
        Pensieve extracts a voice embedding for each diarized speaker using a
        Python sidecar (<code>extra/embed_speakers.py</code>,{" "}
        <a
          href="https://github.com/resemble-ai/Resemblyzer"
          onClick={(e) => {
            e.preventDefault();
            mainApi.openWeb("https://github.com/resemble-ai/Resemblyzer");
          }}
        >
          Resemblyzer
        </a>
        ). Install with <code>pip install resemblyzer librosa numpy</code>.
      </Text>
      <SettingsSwitchField
        form={form}
        field="whisperx.embeddings.enabled"
        label="Enable speaker embeddings"
        description="Compute voice embeddings after diarization and match them against saved profiles. Requires the Python sidecar."
      />
      <SettingsTextField
        {...form.register("whisperx.embeddings.pythonPath")}
        label="Embeddings Python interpreter (optional)"
        description="Defaults to the WhisperX Python interpreter, then `python3` on PATH."
      />
      <SettingsTextField
        {...form.register("whisperx.embeddings.scriptPath")}
        label="Embedding script path (optional)"
        description="Override the bundled `embed_speakers.py`. Leave blank to use the default location."
      />
      <SettingsTextField
        {...form.register("whisperx.embeddings.matchThreshold", {
          valueAsNumber: true,
        })}
        label="Match threshold"
        description="Cosine similarity required to auto-label a speaker (0 – 1). Typical: 0.70 – 0.80."
        type="number"
      />
      {/* eslint-disable-next-line @typescript-eslint/no-use-before-define */}
      <SpeakerProfilesPanel />

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
    </Tabs.Content>
  );
};

const TestTranscriptionPanel: FC = () => {
  const testMutation = useMutation({
    mutationFn: whisperxApi.testTranscriptionPipeline,
  });
  const result = testMutation.data;

  return (
    <Flex gap="0.5rem" align="center" mt="0.25rem" mb="0.5rem">
      <Button
        type="button"
        variant="outline"
        onClick={() => testMutation.mutate()}
        disabled={testMutation.isPending}
      >
        <HiPlay />
        {testMutation.isPending ? "Testing…" : "Test transcription pipeline"}
      </Button>
      {result && (
        <Text size="2" color={result.ok ? "green" : "red"}>
          {result.message}
        </Text>
      )}
    </Flex>
  );
};

const isMissingModuleMessage = (msg: string) =>
  msg.includes("No module named") || msg.includes("ModuleNotFoundError");

const SpeakerProfilesPanel: FC = () => {
  const qc = useQueryClient();
  const { data: profiles } = useQuery({
    queryKey: [QueryKeys.SpeakerProfiles],
    queryFn: speakerProfilesApi.list,
  });
  const { data: status } = useQuery({
    queryKey: [QueryKeys.SpeakerPipelineStatus],
    queryFn: speakerProfilesApi.getStatus,
    refetchInterval: 5000,
  });

  const [depsBanner, setDepsBanner] = useState<
    "hidden" | "show" | "installing" | "done"
  >("hidden");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [QueryKeys.SpeakerProfiles] });
    qc.invalidateQueries({ queryKey: [QueryKeys.SpeakerPipelineStatus] });
  };

  const testMutation = useMutation({
    mutationFn: speakerProfilesApi.testPipeline,
    onSettled: invalidate,
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => speakerProfilesApi.remove(id),
    onSettled: invalidate,
  });
  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      speakerProfilesApi.rename(id, name),
    onSettled: invalidate,
  });

  // Background dry-run on mount: show banner if deps are missing.
  useEffect(() => {
    let cancelled = false;
    const silentCheck = async () => {
      try {
        const result = await speakerProfilesApi.testPipeline();
        if (
          !cancelled &&
          !result.ok &&
          isMissingModuleMessage(result.message)
        ) {
          setDepsBanner("show");
        }
      } catch {
        /* ignore */
      }
    };
    // Only run if no prior successful dry-run recorded.
    if (!status?.lastDryRun?.ok) {
      silentCheck();
    }
    return () => {
      cancelled = true;
    };
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInstallAndTest = async () => {
    setDepsBanner("installing");
    await speakerProfilesApi.installDeps();
    setDepsBanner("done");
    testMutation.mutate();
  };

  const lastError = status?.lastError;
  const lastDryRun = status?.lastDryRun;
  const testResult = testMutation.data;

  const showInstallButton =
    (testResult &&
      !testResult.ok &&
      isMissingModuleMessage(testResult.message)) ||
    (lastDryRun &&
      !lastDryRun.ok &&
      isMissingModuleMessage(lastDryRun.message));

  return (
    <>
      {depsBanner === "show" && (
        <Callout.Root color="amber" variant="surface" mt="0.5rem">
          <Callout.Icon>
            <HiOutlineXCircle />
          </Callout.Icon>
          <Callout.Text>
            Embedding dependencies not installed.{" "}
            <Button size="1" variant="soft" onClick={handleInstallAndTest}>
              Click to install
            </Button>
          </Callout.Text>
        </Callout.Root>
      )}
      {depsBanner === "installing" && (
        <Callout.Root color="amber" variant="surface" mt="0.5rem">
          <Callout.Icon>
            <Spinner size="1" />
          </Callout.Icon>
          <Callout.Text>Installing dependencies…</Callout.Text>
        </Callout.Root>
      )}
      <Heading mt="1.5rem" size="3">
        Saved profiles
      </Heading>
      <Flex gap="0.5rem" align="center" mt="0.25rem" mb="0.5rem">
        <Button
          type="button"
          variant="outline"
          onClick={() => testMutation.mutate()}
          disabled={testMutation.isPending}
        >
          <HiPlay />
          {testMutation.isPending ? "Testing…" : "Test embedding pipeline"}
        </Button>
        {testResult && (
          <Text size="2" color={testResult.ok ? "green" : "red"}>
            {testResult.ok ? "OK: " : "Failed: "}
            {testResult.message}
          </Text>
        )}
        {!testResult && lastDryRun && (
          <Text size="2" color={lastDryRun.ok ? "green" : "red"}>
            Last run: {lastDryRun.ok ? "OK" : "Failed"} — {lastDryRun.message}
          </Text>
        )}
      </Flex>
      {showInstallButton && (
        <Flex align="center" gap="0.5rem" mt="0.25rem" mb="0.5rem">
          <Button
            type="button"
            variant="soft"
            color="amber"
            onClick={handleInstallAndTest}
            disabled={testMutation.isPending || depsBanner === "installing"}
          >
            {depsBanner === "installing" ? (
              <>
                <Spinner size="1" /> Installing…
              </>
            ) : (
              "Auto-install dependencies"
            )}
          </Button>
          <Text size="1" color="gray">
            Will run: uv pip install --system resemblyzer librosa numpy
          </Text>
        </Flex>
      )}
      {lastError && (
        <Callout.Root color="red" variant="surface" mt="0.5rem">
          <Callout.Icon>
            <HiOutlineXCircle />
          </Callout.Icon>
          <Callout.Text>
            Last pipeline error ({lastError.stage}): {lastError.message}
          </Callout.Text>
        </Callout.Root>
      )}
      {profiles && profiles.length === 0 && (
        <Text as="p" color="gray" size="2" mt="0.5rem">
          No profiles saved yet. Rename a speaker on any recording and click the
          bookmark icon to save them as a profile.
        </Text>
      )}
      {profiles && profiles.length > 0 && (
        <Flex direction="column" gap="0.25rem" mt="0.5rem">
          {profiles.map((profile) => (
            <Flex
              key={profile.id}
              align="center"
              gap="0.5rem"
              py="0.25rem"
              style={{ borderBottom: "1px solid var(--gray-a4)" }}
            >
              <Text
                style={{ flexGrow: 1, cursor: "pointer" }}
                onClick={() => {
                  const next = window.prompt(
                    "Rename speaker profile",
                    profile.name,
                  );
                  if (next && next.trim() && next.trim() !== profile.name) {
                    renameMutation.mutate({
                      id: profile.id,
                      name: next.trim(),
                    });
                  }
                }}
              >
                {profile.name}
              </Text>
              <Badge color="gray" variant="soft">
                {profile.embedding.length}d
              </Badge>
              <Text size="1" color="gray">
                added {new Date(profile.createdAt).toLocaleDateString()}
              </Text>
              <IconButton
                variant="ghost"
                color="red"
                size="1"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete voice profile “${profile.name}”? Future recordings will no longer be auto-labeled for this speaker.`,
                    )
                  ) {
                    removeMutation.mutate(profile.id);
                  }
                }}
                aria-label="Delete profile"
              >
                <HiOutlineTrash />
              </IconButton>
            </Flex>
          ))}
        </Flex>
      )}
    </>
  );
};
