import { getSettings } from "../domain/settings";

export const llmApi = {
  testSummarizationPipeline: async (): Promise<{
    ok: boolean;
    message: string;
  }> => {
    const { llm } = await getSettings();

    if (llm.provider === "openai") {
      // For OpenAI, just confirm configuration looks present.
      const apiKey = llm.providerConfig.openai.chatModel.apiKey?.trim() ?? "";
      if (!apiKey) {
        return {
          ok: false,
          message:
            "OpenAI API key is not set. Add it under Settings → Summarization.",
        };
      }
      return {
        ok: true,
        message: "OpenAI provider configured — API key present.",
      };
    }

    // Ollama path.
    const baseUrl =
      llm.providerConfig.ollama.chatModel.baseUrl?.trim() ||
      "http://localhost:11434";
    const model = llm.providerConfig.ollama.chatModel.model?.trim() || "(none)";

    const tagsUrl = `${baseUrl.replace(/\/$/, "")}/api/tags`;

    let tags: { models?: { name: string }[] };
    try {
      const res = await fetch(tagsUrl, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return {
          ok: false,
          message: `Ollama not running or unreachable at ${baseUrl} (HTTP ${res.status}). Start it with \`ollama serve\`.`,
        };
      }
      tags = (await res.json()) as { models?: { name: string }[] };
    } catch (err) {
      return {
        ok: false,
        message: `Ollama not running — could not reach ${baseUrl}. Start it with \`ollama serve\`.`,
      };
    }

    const available = (tags.models ?? []).map((m) => m.name);
    const found = available.some(
      (n) => n === model || n.startsWith(`${model}:`),
    );

    if (!found) {
      return {
        ok: false,
        message: `Model "${model}" not found in Ollama. Run \`ollama pull ${model}\` to download it.`,
      };
    }

    return { ok: true, message: `Ollama running — model ${model} available.` };
  },
};
