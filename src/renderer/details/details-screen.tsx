import { FC, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, Flex, Tabs } from "@radix-ui/themes";
import { HiMiniPencilSquare, HiOutlineBars3BottomLeft } from "react-icons/hi2";
import { RiRobot2Line } from "react-icons/ri";
import { historyDetailsRoute } from "../router/router";
import { QueryKeys } from "../../query-keys";
import { historyApi } from "../api";
import { PageContainer } from "../common/page-container";
import { Transscript } from "./transcript/transscript";
import { useManagedAudio } from "./use-managed-audio";
import { AudioControls } from "./audio-controls";
import { Notes } from "./notes";
import { Summary } from "./summary";
import { EmptyState } from "../common/empty-state";
import { SearchBar } from "./search-bar";
import { ResponsiveTabTrigger } from "../common/responsive-tab-trigger";
import { TranscriptVersionBar } from "./transcript-version-bar";
import { RecordingTranscript } from "../../types";

export const DetailsScreen: FC = () => {
  const qc = useQueryClient();
  const { id } = historyDetailsRoute.useParams();
  const [tab, setTab] = useState("transcript");
  const { data: recording } = useQuery({
    queryKey: [QueryKeys.History, id],
    queryFn: () => historyApi.getRecordingMeta(id),
  });
  const { data: transcript } = useQuery({
    queryKey: [QueryKeys.Transcript, id],
    queryFn: () => historyApi.getRecordingTranscript(id),
  });

  // If there's an active transcript version, load it and prefer it over the
  // legacy transcript.json. Falls back to legacy when no versions exist.
  const activeVersionId = recording?.activeTranscriptVersionId;
  const { data: activeVersion } = useQuery({
    queryKey: [QueryKeys.Transcript, id, "active", activeVersionId],
    queryFn: () => historyApi.getActiveTranscriptVersion(id),
    enabled: !!recording,
  });

  // Build a RecordingTranscript-shaped object from the active version
  const effectiveTranscript: RecordingTranscript | null | undefined = activeVersion
    ? {
        result: { language: activeVersion.language ?? "" },
        transcription: activeVersion.items,
      }
    : transcript;

  const audio = useManagedAudio(effectiveTranscript ?? undefined);

  const { data: versions } = useQuery({
    queryKey: [QueryKeys.Transcript, id, "versions"],
    queryFn: () => historyApi.listTranscriptVersions(id),
    enabled: !!recording,
  });

  if (!recording || !effectiveTranscript) {
    return (
      <PageContainer title={recording?.name ?? "Untitled Recording"}>
        <EmptyState>Loading...</EmptyState>
      </PageContainer>
    );
  }

  return (
    <Tabs.Root value={tab} onValueChange={setTab} style={{ height: "100%" }}>
      <PageContainer
        title={recording?.name ?? "Untitled Recording"}
        statusButtons={
          <SearchBar
            transcript={effectiveTranscript}
            onJumpTo={(time) => {
              setTab("transcript");
              audio.jump(time / 1000 - 1);
              setTimeout(() => audio.scrollTo(time));
            }}
          />
        }
        tabs={
          <Tabs.List style={{ flexGrow: "1" }}>
            <ResponsiveTabTrigger
              value="transcript"
              icon={<HiOutlineBars3BottomLeft />}
            >
              Transcript
            </ResponsiveTabTrigger>
            <ResponsiveTabTrigger value="summary" icon={<RiRobot2Line />}>
              Summary
            </ResponsiveTabTrigger>
            <ResponsiveTabTrigger value="notes" icon={<HiMiniPencilSquare />}>
              Notes
            </ResponsiveTabTrigger>
          </Tabs.List>
        }
      >
        <Flex direction="column" maxHeight="100%" height="100%">
          <Box flexGrow="1" overflowY="auto">
            <Tabs.Content value="transcript">
              {/* Version bar: shown when transcript versions exist */}
              {versions && versions.length > 0 && (
                <TranscriptVersionBar
                  recordingId={id}
                  activeVersionId={activeVersionId}
                  onVersionChange={() => {
                    qc.invalidateQueries({ queryKey: [QueryKeys.History, id] });
                    qc.invalidateQueries({ queryKey: [QueryKeys.Transcript, id, "active"] });
                  }}
                />
              )}
              {effectiveTranscript && (
                <Transscript
                  meta={recording}
                  updateMeta={(update) =>
                    historyApi.updateRecordingMeta(id, update)
                  }
                  transcript={effectiveTranscript}
                  audio={audio}
                  recordingId={id}
                />
              )}
            </Tabs.Content>
            <Tabs.Content value="notes" asChild>
              <Notes
                meta={recording}
                updateMeta={(update) =>
                  historyApi.updateRecordingMeta(id, update)
                }
              />
            </Tabs.Content>
            <Tabs.Content value="summary">
              <Summary
                meta={recording}
                onJumpTo={(time) => {
                  setTab("transcript");
                  audio.jump(time / 1000 - 1);
                  audio.play();
                  setTimeout(() => audio.scrollTo(time));
                }}
              />
            </Tabs.Content>
          </Box>
          <Box>
            <AudioControls audio={audio} id={id} />
          </Box>
        </Flex>
      </PageContainer>
    </Tabs.Root>
  );
};
