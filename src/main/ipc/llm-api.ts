import { execa } from "execa";
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

  ollamaStatus: async (): Promise<{ running: boolean; installed: boolean }> => {
    // Check if ollama binary exists
    let installed = true;
    try {
      await execa("ollama", ["--version"], { timeout: 5000 });
    } catch (err: any) {
      // ENOENT means not found on PATH
      if (err.code === "ENOENT") {
        installed = false;
      }
      // Other errors (e.g. non-zero exit) still mean it's installed
    }

    // Check if Ollama HTTP is reachable
    let running = false;
    try {
      const res = await fetch("http://localhost:11434", {
        signal: AbortSignal.timeout(3000),
      });
      running = res.ok || res.status < 500;
    } catch {
      running = false;
    }

    return { running, installed };
  },

  ollamaStart: async (): Promise<{ ok: boolean; message: string }> => {
    const isWindows = process.platform === "win32";
    try {
      if (isWindows) {
        // Detached, no window — Windows
        const child = execa("ollama", ["serve"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
      } else {
        // Mac/Linux
        const child = execa("ollama", ["serve"], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      }
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return { ok: false, message: "Ollama not found on PATH." };
      }
      return { ok: false, message: String(err.message ?? err) };
    }

    // Poll until reachable (max 10s)
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise<void>((r) => {
        setTimeout(r, 500);
      });
      try {
        const res = await fetch("http://localhost:11434", {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok || res.status < 500) {
          return { ok: true, message: "Ollama started." };
        }
      } catch {
        // keep polling
      }
    }
    return { ok: false, message: "Ollama did not respond within 10 seconds." };
  },

  ollamaStop: async (): Promise<{ ok: boolean; message: string }> => {
    const isWindows = process.platform === "win32";
    try {
      if (isWindows) {
        await execa("taskkill", ["/f", "/im", "ollama.exe"]);
      } else {
        await execa("pkill", ["ollama"]);
      }
      return { ok: true, message: "Ollama stopped." };
    } catch (err: any) {
      // pkill/taskkill exit 1 when no process found — treat as already stopped
      if (err.exitCode === 1 || err.exitCode === 128) {
        return { ok: true, message: "Ollama was not running." };
      }
      return { ok: false, message: String(err.message ?? err) };
    }
  },
};
