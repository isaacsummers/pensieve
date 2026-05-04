/**
 * Unit tests for the pure, non-electron helpers in the WhisperX pipeline.
 *
 * Run with:
 *   node --require ts-node/register --test src/main/domain/__tests__/whisperx.test.ts
 *
 * These functions are the fragile layers that drove most of the branch's
 * iteration loop (string-building for Python CLIs, speaker-label
 * normalization, time formatting). Keeping them covered prevents whole
 * classes of regressions from landing silently.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildArgs } from "../../../main-utils";
import {
  normalizeSpeaker,
  toHms,
  whisperxToTranscript,
} from "../whisperx-utils";

describe("buildArgs", () => {
  it("emits a single-dash flag for single-character keys", () => {
    assert.deepEqual(buildArgs({ v: "value" }), ["-v", "value"]);
  });

  it("emits a double-dash flag for multi-character keys", () => {
    assert.deepEqual(buildArgs({ model: "large-v3" }), ["--model", "large-v3"]);
  });

  it("renders boolean true as a bare flag", () => {
    assert.deepEqual(buildArgs({ diarize: true }), ["--diarize"]);
  });

  it("omits the flag entirely when value is false", () => {
    assert.deepEqual(buildArgs({ diarize: false }), []);
  });

  it("emits a bare flag when value is null", () => {
    assert.deepEqual(buildArgs({ foo: null }), ["--foo"]);
  });

  it("preserves zero values instead of silently dropping them", () => {
    // Regression: the prior truthy-check dropped `0` along with `false`.
    assert.deepEqual(buildArgs({ batch_size: 0 }), ["--batch_size", "0"]);
  });

  it("preserves empty string values instead of silently dropping them", () => {
    assert.deepEqual(buildArgs({ language: "" }), ["--language", ""]);
  });

  it("positional underscore keys produce bare values", () => {
    assert.deepEqual(buildArgs({ _0: "/path/to/input.wav" }), [
      "/path/to/input.wav",
    ]);
  });
});

describe("normalizeSpeaker", () => {
  it("strips the SPEAKER_ prefix and drops leading zeros", () => {
    assert.equal(normalizeSpeaker("SPEAKER_07"), "7");
  });

  it("returns null for an explicit null", () => {
    assert.equal(normalizeSpeaker(null), null);
  });

  it("returns null for an empty string", () => {
    assert.equal(normalizeSpeaker(""), null);
  });

  it("returns null for undefined", () => {
    assert.equal(normalizeSpeaker(undefined), null);
  });

  it("returns null for non-string inputs", () => {
    assert.equal(normalizeSpeaker(42), null);
  });

  it("returns null for labels with no digits", () => {
    assert.equal(normalizeSpeaker("UNKNOWN"), null);
  });
});

describe("toHms", () => {
  it("formats zero as 00:00:00.000", () => {
    assert.equal(toHms(0), "00:00:00.000");
  });

  it("formats round second values with millisecond precision", () => {
    assert.equal(toHms(65), "00:01:05.000");
  });

  it("formats fractional seconds with millisecond precision", () => {
    assert.equal(toHms(3723.456), "01:02:03.456");
  });

  it("clamps negative values to zero", () => {
    assert.equal(toHms(-1), "00:00:00.000");
  });
});

describe("whisperxToTranscript", () => {
  it("converts a basic segment", () => {
    const result = whisperxToTranscript({
      language: "en",
      segments: [
        { start: 1.5, end: 2.5, text: " hello ", speaker: "SPEAKER_00" },
      ],
    });
    assert.equal(result.result.language, "en");
    assert.equal(result.transcription.length, 1);
    const seg = result.transcription[0];
    assert.equal(seg.text, "hello");
    assert.equal(seg.speaker, "0");
    assert.deepEqual(seg.offsets, { from: 1500, to: 2500 });
    assert.equal(seg.timestamps.from, "00:00:01.500");
    assert.equal(seg.timestamps.to, "00:00:02.500");
  });

  it("preserves an empty speaker key for null labels", () => {
    const result = whisperxToTranscript({
      segments: [{ start: 0, end: 1, text: "x", speaker: undefined }],
    });
    // `null` normalized speakers are stored as an empty string on transcript
    // items so the existing UI keeps working; the embedding pipeline drops
    // them separately via its own filter (see processWavFile).
    assert.equal(result.transcription[0].speaker, "");
  });

  it("defaults language to 'auto' when missing", () => {
    const result = whisperxToTranscript({ segments: [] });
    assert.equal(result.result.language, "auto");
    assert.equal(result.transcription.length, 0);
  });
});
