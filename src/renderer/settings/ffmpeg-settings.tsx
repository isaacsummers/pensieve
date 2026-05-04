import { FC } from "react";
import { useFormContext } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import { Settings } from "../../types";
import { ffmpegApi } from "../api";
import { SettingsSwitchField } from "./settings-switch-field";
import { SettingsTextField } from "./settings-text-field";
import { SettingsTab } from "./tabs";

const FFMPEG_STATUS_QUERY = ["ffmpeg-status"] as const;

const FfmpegStatusRow: FC = () => {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({
    queryKey: FFMPEG_STATUS_QUERY,
    queryFn: ffmpegApi.getStatus,
  });

  const useExisting = useMutation({
    mutationFn: async () => {
      if (!data?.path) throw new Error("No detected ffmpeg to adopt");
      return ffmpegApi.useExisting(data.path);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: FFMPEG_STATUS_QUERY }),
  });

  const openDownload = useMutation({
    mutationFn: ffmpegApi.openDownloadPage,
  });

  if (isLoading) {
    return <div style={{ padding: "8px 0" }}>Detecting FFmpeg…</div>;
  }

  const ok = data?.ok === true;
  const showAdopt = ok && data?.source !== "bundled";

  return (
    <div
      style={{
        padding: "12px",
        margin: "8px 0 16px",
        border: "1px solid var(--border, #444)",
        borderRadius: 6,
        background: "var(--panel, rgba(255,255,255,0.03))",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>FFmpeg</div>
      {ok ? (
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <div>
            <strong>Status:</strong> ✅ detected ({data.source})
          </div>
          <div>
            <strong>Path:</strong> <code>{data.path}</code>
          </div>
          <div>
            <strong>Version:</strong> {data.version ?? "unknown"}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 13, lineHeight: 1.5, color: "#e88" }}>
          <div>
            <strong>Status:</strong> ❌ not found
          </div>
          <div>{data?.error ?? "ffmpeg is required for post-processing."}</div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button type="button" onClick={() => refetch()} disabled={isLoading}>
          Re-detect
        </button>
        {showAdopt && (
          <button
            type="button"
            onClick={() => useExisting.mutate()}
            disabled={useExisting.isPending}
            title="Copy the detected binary into the app's bundled extra/ folder"
          >
            {useExisting.isPending
              ? "Copying…"
              : "Use existing (copy to extra/)"}
          </button>
        )}
        <button
          type="button"
          onClick={() => openDownload.mutate()}
          disabled={openDownload.isPending}
          title="Open BtbN FFmpeg 7.x release page"
        >
          Download latest (BtbN)
        </button>
      </div>

      {useExisting.data?.ok && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#8e8" }}>
          Copied to {useExisting.data.target}. Re-detecting will now show{" "}
          &quot;bundled&quot;.
        </div>
      )}
      {useExisting.data?.error && (
        <div style={{ marginTop: 8, fontSize: 12, color: "#e88" }}>
          Copy failed: {useExisting.data.error}
        </div>
      )}
    </div>
  );
};

export const FfmpegSettings: FC = () => {
  const form = useFormContext<Settings>();
  return (
    <Tabs.Content value={SettingsTab.Ffmpeg}>
      <FfmpegStatusRow />

      <SettingsTextField
        label="FFMPEG binary path (optional)"
        description="Absolute path to a specific ffmpeg executable. Leave empty to
          autodetect (extra/ffmpeg.exe → C:\\ffmpeg\\bin\\ffmpeg.exe →
          C:\\ffmpeg\\ffmpeg.exe → PATH)."
        {...form.register("ffmpeg.binaryPath")}
      />

      <SettingsSwitchField
        form={form}
        field="ffmpeg.autoTriggerPostProcess"
        label="Automatically post-process audio"
        description="Transcription and summarization will be
          triggered automatically after recording is completed.
          This may be resource-intensive. Disable to manually
          trigger post-processing from the history view."
      />

      <SettingsSwitchField
        form={form}
        field="ffmpeg.removeRawRecordings"
        label="Clean up raw recordings"
        description="After post-processing, initial recording
          files will be removed. Disable to allow re-processing
          recordings afterwards with different settings."
      />

      <SettingsTextField
        label="FFMPEG Filter for Whisper-input"
        description="The FFMPEG complex audio filter applied to the
          input file of whisper."
        {...form.register("ffmpeg.stereoWavFilter")}
      />

      <SettingsTextField
        label="FFMPEG Filter for MP3 creation"
        description="The FFMPEG complex audio filter to the creation
          of MP3 recordings."
        {...form.register("ffmpeg.mp3Filter")}
      />
    </Tabs.Content>
  );
};
