/**
 * Unit tests for the recording-files helpers — the pure logic that decides
 * how per-device additional mic tracks are named on disk. These run under
 * `node --test` like the other unit tests in this folder.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAdditionalMicFileName,
  planAdditionalMicFiles,
  sanitizeDeviceLabel,
} from "../recording-files";

describe("sanitizeDeviceLabel", () => {
  it("returns an empty string for empty input", () => {
    assert.equal(sanitizeDeviceLabel(""), "");
  });

  it("lowercases and dash-separates words", () => {
    assert.equal(
      sanitizeDeviceLabel("Headset Microphone"),
      "headset-microphone",
    );
  });

  it("strips parenthesized hardware suffixes", () => {
    assert.equal(
      sanitizeDeviceLabel("Microphone (Realtek High Definition Audio)"),
      "microphone",
    );
  });

  it("trims to 32 characters", () => {
    const long = "Some Extremely Verbose Device Label That Goes On And On";
    const out = sanitizeDeviceLabel(long);
    assert.ok(out.length <= 32, `expected <=32, got ${out.length} (${out})`);
  });

  it("collapses runs of disallowed characters into a single dash", () => {
    assert.equal(sanitizeDeviceLabel("foo!!!@@@bar"), "foo-bar");
  });

  it("trims leading and trailing dashes", () => {
    assert.equal(sanitizeDeviceLabel("---foo---"), "foo");
  });
});

describe("buildAdditionalMicFileName", () => {
  it("uses the input prefix for input devices", () => {
    const taken = new Set<string>();
    const name = buildAdditionalMicFileName(
      { kind: "input", label: "Headset" },
      0,
      taken,
    );
    assert.equal(name, "mic-headset.webm");
    assert.ok(taken.has("mic-headset.webm"));
  });

  it("uses the output prefix for output devices", () => {
    const taken = new Set<string>();
    const name = buildAdditionalMicFileName(
      { kind: "output", label: "Sonar Gaming" },
      0,
      taken,
    );
    assert.equal(name, "output-sonar-gaming.webm");
  });

  it("falls back to a numeric name when the label is unusable", () => {
    const taken = new Set<string>();
    const name = buildAdditionalMicFileName(
      { kind: "input", label: "" },
      2,
      taken,
    );
    assert.equal(name, "mic-3.webm");
  });

  it("disambiguates collisions with a numeric suffix", () => {
    const taken = new Set<string>();
    const a = buildAdditionalMicFileName(
      { kind: "input", label: "Headset" },
      0,
      taken,
    );
    const b = buildAdditionalMicFileName(
      { kind: "input", label: "Headset" },
      1,
      taken,
    );
    assert.equal(a, "mic-headset.webm");
    assert.equal(b, "mic-headset-2.webm");
  });

  it("never collides with the canonical mic.webm filename", () => {
    const taken = new Set<string>(["mic.webm"]);
    const name = buildAdditionalMicFileName(
      { kind: "input", label: "" },
      // Index 0 would normally produce "mic-1.webm" anyway; force collision
      // with mic.webm by sanitizing to nothing AND seeding the set.
      0,
      taken,
    );
    assert.notEqual(name, "mic.webm");
  });
});

describe("planAdditionalMicFiles", () => {
  it("returns an empty plan when there are no additional tracks", () => {
    const plan = planAdditionalMicFiles([
      {
        data: new ArrayBuffer(0),
        isPrimary: true,
        kind: "input",
        label: "Primary",
        deviceId: "p",
      },
    ]);
    assert.deepEqual(plan, []);
  });

  it("plans one entry per additional track", () => {
    const plan = planAdditionalMicFiles([
      {
        data: new ArrayBuffer(0),
        isPrimary: true,
        kind: "input",
        label: "Primary",
        deviceId: "p",
      },
      {
        data: new ArrayBuffer(0),
        isPrimary: false,
        kind: "input",
        label: "Headset",
        deviceId: "h",
      },
      {
        data: new ArrayBuffer(0),
        isPrimary: false,
        kind: "output",
        label: "Sonar Gaming",
        deviceId: "s",
      },
    ]);
    assert.equal(plan.length, 2);
    assert.equal(plan[0].file.fileName, "mic-headset.webm");
    assert.equal(plan[0].file.kind, "input");
    assert.equal(plan[0].file.deviceId, "h");
    assert.equal(plan[1].file.fileName, "output-sonar-gaming.webm");
    assert.equal(plan[1].file.kind, "output");
  });

  it("never reuses mic.webm or screen.webm", () => {
    const plan = planAdditionalMicFiles([
      {
        data: new ArrayBuffer(0),
        isPrimary: true,
        kind: "input",
        label: "Primary",
        deviceId: "p",
      },
      // Two additional tracks with empty labels would naively try `mic-1` /
      // `mic-2`, both fine. We seed the corner case: a label that sanitizes
      // to nothing, then verify nothing in the plan equals mic.webm.
      {
        data: new ArrayBuffer(0),
        isPrimary: false,
        kind: "input",
        label: "",
        deviceId: "a",
      },
    ]);
    plan.forEach(({ file }) => {
      assert.notEqual(file.fileName, "mic.webm");
      assert.notEqual(file.fileName, "screen.webm");
    });
  });
});
