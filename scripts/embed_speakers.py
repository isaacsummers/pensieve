#!/usr/bin/env python3
"""
Sidecar: extract per-speaker voice embeddings from a recording.

Usage:
  python embed_speakers.py --audio <wav-or-mp3> --segments <segments.json> \
                           [--out <out.json>] [--threshold-sec 0.3]
  python embed_speakers.py --dry-run

Input `segments.json` is a JSON array of
  {"speaker": "0", "start": 1.23, "end": 4.56}
(seconds).

Output JSON (stdout):
  {
    "ok": true,
    "embeddings": {"<speaker>": [..floats..], ...},
    "durations": {"<speaker>": <seconds>, ...},
    "method": "resemblyzer",
    "dim": <int>
  }

Errors go to stderr with bracketed prefixes: [EMBED], [LOAD], [ERROR].
Exit code 0 on success, non-zero otherwise.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from typing import Any, Dict, List


def log(prefix: str, msg: str) -> None:
    sys.stderr.write(f"[{prefix}] {msg}\n")
    sys.stderr.flush()


def fail(message: str, code: int = 1) -> None:
    log("ERROR", message)
    # Also emit a structured error on stdout so the caller can parse it cleanly.
    try:
        sys.stdout.write(json.dumps({"ok": False, "error": message}) + "\n")
        sys.stdout.flush()
    except Exception:
        pass
    sys.exit(code)


def _import_deps():
    try:
        import numpy as np  # noqa: F401
    except Exception as e:
        fail(f"numpy import failed: {e}. Install with `pip install numpy`.")
    try:
        import soundfile  # noqa: F401
    except Exception as e:
        fail(
            f"soundfile import failed: {e}. "
            "Install with `pip install soundfile`."
        )
    try:
        import librosa  # noqa: F401
    except Exception as e:
        fail(f"librosa import failed: {e}. Install with `pip install librosa`.")
    try:
        from resemblyzer import VoiceEncoder, preprocess_wav  # noqa: F401
    except Exception as e:
        fail(
            "resemblyzer import failed: "
            f"{e}. Install with `pip install resemblyzer`."
        )


def load_audio(path: str, target_sr: int = 16000):
    """Legacy full-file loader. Retained for mp3 / non-wav inputs where
    soundfile can't seek natively; the extract path now prefers the
    streaming `iter_speaker_audio` helper for wav inputs."""
    import librosa

    log("LOAD", f"loading audio (full): {path}")
    t0 = time.time()
    try:
        wav, sr = librosa.load(path, sr=target_sr, mono=True)
    except Exception as e:
        fail(f"failed to load audio '{path}': {e}")
    log("LOAD", f"loaded {len(wav)} samples @ {sr} Hz in {time.time()-t0:.2f}s")
    return wav, sr


def iter_speaker_audio(path: str, grouped, target_sr: int = 16000):
    """Yield (speaker_key, concatenated_samples, total_duration_sec) tuples
    using random-access reads via libsndfile.

    This avoids loading the entire recording into memory — a 3-hour meeting
    at 16 kHz mono float32 is ~700MB. For each speaker we seek to every
    span's start sample and read only the samples we need. Streams that
    soundfile cannot open (e.g. mp3 on systems without libsndfile mp3
    support) fall back to the librosa full-file loader once, and we slice
    the in-memory array.
    """
    import numpy as np
    import soundfile as sf

    try:
        snd = sf.SoundFile(path, mode="r")
    except Exception as e:
        log(
            "LOAD",
            f"soundfile could not open '{path}' ({e}); "
            "falling back to librosa full-file decode",
        )
        wav_full, sr = load_audio(path, target_sr=target_sr)
        for speaker, spans in grouped.items():
            chunks = []
            total_dur = 0.0
            for span in spans:
                s_idx = max(0, int(span["start"] * sr))
                e_idx = min(len(wav_full), int(span["end"] * sr))
                if e_idx <= s_idx:
                    continue
                chunks.append(wav_full[s_idx:e_idx])
                total_dur += (e_idx - s_idx) / sr
            if chunks:
                yield speaker, np.concatenate(chunks).astype(np.float32), total_dur
            else:
                yield speaker, np.zeros(0, dtype=np.float32), 0.0
        return

    try:
        native_sr = snd.samplerate
        channels = snd.channels
        log(
            "LOAD",
            f"opened '{path}' via soundfile: {native_sr} Hz, {channels}ch, "
            f"{snd.frames} frames",
        )
        for speaker, spans in grouped.items():
            chunks = []
            total_dur = 0.0
            for span in spans:
                start_s = max(0.0, float(span["start"]))
                end_s = max(start_s, float(span["end"]))
                s_frame = int(start_s * native_sr)
                e_frame = min(snd.frames, int(end_s * native_sr))
                if e_frame <= s_frame:
                    continue
                try:
                    snd.seek(s_frame)
                    data = snd.read(e_frame - s_frame, dtype="float32")
                except Exception as e:
                    log("ERROR", f"soundfile read failed for {speaker}: {e}")
                    continue
                if data.ndim == 2:
                    # Downmix to mono.
                    data = data.mean(axis=1).astype(np.float32)
                if native_sr != target_sr:
                    import librosa

                    data = librosa.resample(
                        data, orig_sr=native_sr, target_sr=target_sr
                    )
                chunks.append(data)
                total_dur += (e_frame - s_frame) / native_sr
            if chunks:
                yield speaker, np.concatenate(chunks).astype(np.float32), total_dur
            else:
                yield speaker, np.zeros(0, dtype=np.float32), 0.0
    finally:
        try:
            snd.close()
        except Exception:
            pass


def group_segments_by_speaker(
    segments: List[Dict[str, Any]],
) -> Dict[str, List[Dict[str, Any]]]:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for seg in segments:
        speaker = str(seg.get("speaker") or "")
        if not speaker:
            continue
        start = float(seg.get("start") or 0.0)
        end = float(seg.get("end") or 0.0)
        if end <= start:
            continue
        grouped.setdefault(speaker, []).append({"start": start, "end": end})
    return grouped


def compute_embedding(encoder, wav_slice):
    # resemblyzer's embed_utterance is lightweight and averages partial embeds.
    # preprocess_wav is optional when we already have 16kHz mono float32.
    try:
        emb = encoder.embed_utterance(wav_slice)
    except Exception as e:
        raise RuntimeError(f"embed_utterance failed: {e}") from e
    return emb


def run_dry_run() -> None:
    _import_deps()
    import numpy as np
    from resemblyzer import VoiceEncoder

    log("EMBED", "dry-run: loading VoiceEncoder")
    try:
        encoder = VoiceEncoder(device="cpu", verbose=False)
    except Exception as e:
        fail(f"VoiceEncoder init failed: {e}")

    log("EMBED", "dry-run: synthesising 2s silence @ 16kHz")
    silence = np.zeros(16000 * 2, dtype=np.float32)
    try:
        emb = encoder.embed_utterance(silence)
    except Exception as e:
        fail(f"embed_utterance on silence failed: {e}")

    out = {
        "ok": True,
        "dryRun": True,
        "dim": int(len(emb)),
        "method": "resemblyzer",
    }
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
    log("EMBED", "dry-run OK")


def run_extract(args) -> None:
    _import_deps()
    import numpy as np
    from resemblyzer import VoiceEncoder

    if not args.audio:
        fail("--audio is required")
    if not args.segments:
        fail("--segments is required")

    try:
        with open(args.segments, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except Exception as e:
        fail(f"failed to read segments json '{args.segments}': {e}")

    if isinstance(payload, dict) and "segments" in payload:
        segments = payload["segments"]
    elif isinstance(payload, list):
        segments = payload
    else:
        fail("segments json must be a list or {segments: [...] }")
        return

    grouped = group_segments_by_speaker(segments)
    if not grouped:
        fail("no speaker segments found after filtering")

    target_sr = 16000

    log("EMBED", "initialising VoiceEncoder")
    try:
        encoder = VoiceEncoder(device="cpu", verbose=False)
    except Exception as e:
        fail(f"VoiceEncoder init failed: {e}")

    min_sec = float(args.threshold_sec)
    embeddings: Dict[str, List[float]] = {}
    durations: Dict[str, float] = {}

    for speaker, concatenated, total_dur in iter_speaker_audio(
        args.audio, grouped, target_sr=target_sr
    ):
        try:
            if concatenated.size == 0 or total_dur < min_sec:
                log(
                    "EMBED",
                    f"skipping speaker {speaker}: only {total_dur:.2f}s of audio "
                    f"(< {min_sec:.2f}s threshold)",
                )
                continue

            log(
                "EMBED",
                f"speaker {speaker}: {total_dur:.2f}s — embedding",
            )
            emb = compute_embedding(encoder, concatenated)
            embeddings[speaker] = [float(x) for x in emb.tolist()]
            durations[speaker] = round(total_dur, 3)
        except Exception as e:
            log("ERROR", f"speaker {speaker}: {e}")
            # Skip this speaker but continue with others.
            continue

    if not embeddings:
        fail("no embeddings produced (all speakers skipped)")

    out = {
        "ok": True,
        "embeddings": embeddings,
        "durations": durations,
        "method": "resemblyzer",
        "dim": len(next(iter(embeddings.values()))),
    }
    payload_text = json.dumps(out)
    if args.out:
        try:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(payload_text)
        except Exception as e:
            fail(f"failed to write --out file '{args.out}': {e}")
    sys.stdout.write(payload_text + "\n")
    sys.stdout.flush()
    log("EMBED", f"done — {len(embeddings)} speaker embedding(s)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio")
    parser.add_argument("--segments")
    parser.add_argument("--out")
    parser.add_argument("--threshold-sec", type=float, default=0.3)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        if args.dry_run:
            run_dry_run()
        else:
            run_extract(args)
    except SystemExit:
        raise
    except Exception as e:
        log("ERROR", f"unhandled: {e}")
        log("ERROR", traceback.format_exc())
        fail(str(e))


if __name__ == "__main__":
    main()
