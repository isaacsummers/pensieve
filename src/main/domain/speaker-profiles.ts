import path from "path";
import fs from "fs-extra";
import { randomUUID } from "crypto";
import { app } from "electron";
import log from "electron-log/main";
import { execa } from "execa";
import * as settings from "./settings";
import { SpeakerProfile } from "../../types";
import { invalidateUiKeys } from "../ipc/invalidate-ui";
import { QueryKeys } from "../../query-keys";

const profilesFile = () =>
  path.join(app.getPath("userData"), "speaker-profiles.json");

type ProfilesShape = {
  profiles: SpeakerProfile[];
  lastError: {
    stage: string;
    message: string;
    at: string;
  } | null;
  lastDryRun?: {
    ok: boolean;
    message: string;
    dim?: number;
    at: string;
  } | null;
};

const empty = (): ProfilesShape => ({
  profiles: [],
  lastError: null,
  lastDryRun: null,
});

const read = async (): Promise<ProfilesShape> => {
  try {
    if (!fs.existsSync(profilesFile())) return empty();
    const raw = (await fs.readJSON(profilesFile())) as Partial<ProfilesShape>;
    return {
      profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
      lastError: raw.lastError ?? null,
      lastDryRun: raw.lastDryRun ?? null,
    };
  } catch (e) {
    log.error("speaker-profiles: failed to read store", e);
    return empty();
  }
};

const write = async (data: ProfilesShape) => {
  await fs.writeJSON(profilesFile(), data, { spaces: 2 });
  await invalidateUiKeys(QueryKeys.SpeakerProfiles);
};

export const listProfiles = async (): Promise<SpeakerProfile[]> => {
  return (await read()).profiles;
};

export const getLastError = async () => {
  const s = await read();
  return { lastError: s.lastError, lastDryRun: s.lastDryRun ?? null };
};

export const setLastError = async (
  err: { stage: string; message: string } | null,
) => {
  const s = await read();
  s.lastError = err ? { ...err, at: new Date().toISOString() } : null;
  await write(s);
};

export const upsertProfile = async (
  profile: Omit<SpeakerProfile, "id" | "createdAt" | "updatedAt"> &
    Partial<Pick<SpeakerProfile, "id">>,
): Promise<SpeakerProfile> => {
  const s = await read();
  const now = new Date().toISOString();
  const existing = profile.id
    ? s.profiles.find((p) => p.id === profile.id)
    : undefined;
  if (existing) {
    existing.name = profile.name;
    existing.embedding = profile.embedding;
    existing.sampleCount = profile.sampleCount ?? existing.sampleCount ?? 1;
    existing.updatedAt = now;
    await write(s);
    return existing;
  }
  const created: SpeakerProfile = {
    id: profile.id ?? randomUUID(),
    name: profile.name,
    embedding: profile.embedding,
    sampleCount: profile.sampleCount ?? 1,
    createdAt: now,
    updatedAt: now,
  };
  s.profiles.push(created);
  await write(s);
  return created;
};

export const renameProfile = async (id: string, name: string) => {
  const s = await read();
  const p = s.profiles.find((x) => x.id === id);
  if (!p) throw new Error(`profile ${id} not found`);
  p.name = name;
  p.updatedAt = new Date().toISOString();
  await write(s);
  return p;
};

export const removeProfile = async (id: string) => {
  const s = await read();
  s.profiles = s.profiles.filter((p) => p.id !== id);
  await write(s);
};

// --- sidecar ---------------------------------------------------------------

const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (aa === 0 || bb === 0) return 0;
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
};

const resolveScriptPath = async (): Promise<string> => {
  const override = (await settings.getSettings()).whisperx.embeddings
    ?.scriptPath;
  if (override && override.trim()) return override.trim();

  // Candidates: packaged resources, source tree, cwd.
  const candidates: string[] = [];
  // When running under Electron Forge / packaged app, extra/ is copied to
  // resourcesPath. During dev it sits next to the project root.
  try {
    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, "extra", "embed_speakers.py"),
      );
    }
  } catch {
    /* ignore */
  }
  try {
    const here = typeof __dirname === "string" ? __dirname : process.cwd();
    candidates.push(
      path.resolve(here, "..", "..", "..", "extra", "embed_speakers.py"),
    );
    candidates.push(
      path.resolve(here, "..", "..", "..", "..", "extra", "embed_speakers.py"),
    );
  } catch {
    /* ignore */
  }
  candidates.push(path.resolve(process.cwd(), "extra", "embed_speakers.py"));

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `embed_speakers.py not found. Tried:\n${candidates.map((c) => `  - ${c}`).join("\n")}`,
  );
};

const resolvePythonCmd = async (): Promise<string> => {
  const s = (await settings.getSettings()).whisperx;
  const explicit = s.embeddings?.pythonPath?.trim();
  if (explicit) return explicit;
  if (s.pythonPath && s.pythonPath.trim()) return s.pythonPath.trim();
  return process.platform === "win32" ? "python" : "python3";
};

export type SidecarResult = {
  ok: true;
  embeddings: Record<string, number[]>;
  durations: Record<string, number>;
  method: string;
  dim: number;
};

const runSidecar = async (
  args: string[],
  opts: { stage: string; timeoutMs?: number },
): Promise<any> => {
  const python = await resolvePythonCmd();
  const script = await resolveScriptPath();
  const fullArgs = [script, ...args];
  log.info(`[speaker-profiles:${opts.stage}] running`, python, fullArgs);

  let result;
  try {
    result = await execa(python, fullArgs, {
      stdio: "pipe",
      timeout: opts.timeoutMs ?? 5 * 60_000,
      reject: false,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setLastError({ stage: opts.stage, message: msg });
    throw new Error(
      `sidecar launch failed (${opts.stage}): ${msg}. Is Python installed and on PATH?`,
    );
  }

  // Forward sidecar stderr to electron-log so we can diagnose later.
  const stderr = (result.stderr || "").toString();
  if (stderr.trim()) {
    stderr
      .split("\n")
      .filter(Boolean)
      .forEach((line) => log.info(`[speaker-profiles:${opts.stage}] ${line}`));
  }

  const stdout = (result.stdout || "").toString().trim();
  // The script writes exactly one JSON line to stdout on success, or an
  // {"ok":false,"error":...} line on failure. Tolerate extra blank lines.
  const jsonLine =
    stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() || "";

  let parsed: any = null;
  if (jsonLine) {
    try {
      parsed = JSON.parse(jsonLine);
    } catch {
      parsed = null;
    }
  }

  if (result.exitCode !== 0 || (parsed && parsed.ok === false)) {
    const errMsg =
      (parsed && parsed.error) ||
      stderr.trim().split("\n").slice(-5).join(" | ") ||
      `sidecar exited with code ${result.exitCode}`;
    await setLastError({ stage: opts.stage, message: errMsg });
    throw new Error(errMsg);
  }

  return parsed;
};

export const extractEmbeddings = async (params: {
  audioPath: string;
  segments: Array<{ speaker: string; start: number; end: number }>;
}): Promise<SidecarResult> => {
  const tmpSeg = path.join(
    app.getPath("userData"),
    "logs",
    `embed-segments-${Date.now()}.json`,
  );
  await fs.ensureDir(path.dirname(tmpSeg));
  await fs.writeJSON(tmpSeg, { segments: params.segments });
  try {
    const result = (await runSidecar(
      ["--audio", params.audioPath, "--segments", tmpSeg],
      { stage: "embed" },
    )) as SidecarResult;
    await setLastError(null);
    return result;
  } finally {
    await fs.remove(tmpSeg).catch(() => {});
  }
};

export const testPipeline = async (): Promise<{
  ok: boolean;
  message: string;
  dim?: number;
}> => {
  try {
    const parsed = await runSidecar(["--dry-run"], {
      stage: "dry-run",
      timeoutMs: 120_000,
    });
    const s = await read();
    s.lastDryRun = {
      ok: true,
      message: `embedding dim=${parsed.dim} via ${parsed.method}`,
      dim: parsed.dim,
      at: new Date().toISOString(),
    };
    await write(s);
    return { ok: true, message: s.lastDryRun.message, dim: parsed.dim };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const s = await read();
    s.lastDryRun = {
      ok: false,
      message,
      at: new Date().toISOString(),
    };
    await write(s);
    return { ok: false, message };
  }
};

export type SpeakerMatch = {
  profileId: string | null;
  profileName: string | null;
  confidence: number;
  matched: boolean;
};

export const matchSpeaker = async (
  embedding: number[],
  threshold: number,
): Promise<SpeakerMatch> => {
  const profiles = await listProfiles();
  if (profiles.length === 0) {
    return {
      profileId: null,
      profileName: null,
      confidence: 0,
      matched: false,
    };
  }
  let best: SpeakerProfile | null = null;
  let bestSim = -Infinity;
  for (const p of profiles) {
    const sim = cosineSimilarity(embedding, p.embedding);
    if (sim > bestSim) {
      bestSim = sim;
      best = p;
    }
  }
  const confidence = Math.max(0, bestSim);
  return {
    profileId: best?.id ?? null,
    profileName: best?.name ?? null,
    confidence,
    matched: confidence >= threshold,
  };
};
