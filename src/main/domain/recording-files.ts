import { AdditionalMicFile, CapturedMicTrack } from "../../types";

/**
 * Sanitize a device label for use in a filename. Strips disallowed
 * filesystem characters, collapses whitespace, lowercases, and trims to a
 * reasonable max length so we don't produce 200-byte filenames from verbose
 * Windows device descriptions like
 * `Headset Microphone (Steam Streaming Microphone) (NVIDIA High Definition Audio)`.
 *
 * Returns an empty string when the label collapses to nothing usable; the
 * caller is expected to fall back to a generic name + index.
 */
export const sanitizeDeviceLabel = (label: string): string => {
  if (!label) return "";
  // Strip parenthesized hardware suffixes \u2014 they're noisy and rarely
  // disambiguate when the user already picked a friendly device name.
  const stripped = label.replace(/\([^)]*\)/g, "");
  return stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
};

/**
 * Resolve a unique on-disk filename for an additional mic track. We never
 * collide with the canonical `mic.webm` or `screen.webm` and we de-dup
 * across the same call when two devices sanitize to the same slug.
 */
export const buildAdditionalMicFileName = (
  track: { kind: "input" | "output"; label: string },
  index: number,
  taken: Set<string>,
): string => {
  const prefix = track.kind === "output" ? "output" : "mic";
  const slug = sanitizeDeviceLabel(track.label);
  const base = slug ? `${prefix}-${slug}` : `${prefix}-${index + 1}`;

  let candidate = `${base}.webm`;
  let suffix = 2;
  while (taken.has(candidate) || candidate === "mic.webm") {
    candidate = `${base}-${suffix}.webm`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
};

/**
 * Plan a per-track filename layout for the additional mic files. Returns
 * one entry per track including the assigned filename plus the metadata
 * we want to persist on `RecordingMeta`.
 */
export const planAdditionalMicFiles = (
  tracks: CapturedMicTrack[],
): Array<{ track: CapturedMicTrack; file: AdditionalMicFile }> => {
  const additional = tracks.filter((t) => !t.isPrimary);
  const taken = new Set<string>(["mic.webm", "screen.webm"]);
  return additional.map((track, index) => ({
    track,
    file: {
      fileName: buildAdditionalMicFileName(track, index, taken),
      label: track.label,
      deviceId: track.deviceId,
      kind: track.kind,
    },
  }));
};
