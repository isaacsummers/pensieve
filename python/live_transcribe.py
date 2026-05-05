#!/usr/bin/env python3
"""
Live transcription sidecar for Pensieve.

Protocol:
  stdin:  Raw PCM audio, 16 kHz, 16-bit mono, little-endian.
          Chunks arrive in arbitrary sizes; the script accumulates them
          internally. EOF signals end-of-recording; remaining audio is flushed.
  stdout: Newline-delimited JSON (NDJSON). Each line is one message:
            {"type": "status", "status": "loading"|"active"|"done"}
            {"type": "fragment", "seq": N, "text": "...",
             "start_ms": N, "end_ms": N, "is_final": true,
             "language": "en", "speaker": null}
  stderr: Human-readable log lines only (not parsed by Node).
  exit 0: Clean finish.
  exit 1: Fatal error.

Usage:
  python live_transcribe.py \
    [--model base.en] \
    [--device cpu] \
    [--compute-type int8] \
    [--language en] \
    [--chunk-ms 3000] \
    [--overlap-ms 500]
"""

import argparse
import json
import sys
import numpy as np

SAMPLE_RATE = 16_000
BYTES_PER_SAMPLE = 2  # 16-bit PCM


def _log(msg: str) -> None:
    """Write a log line to stderr so Node doesn't accidentally parse it."""
    print(f"[live_transcribe] {msg}", file=sys.stderr, flush=True)


def _emit(msg: dict) -> None:
    """Emit a JSON message on stdout."""
    print(json.dumps(msg), flush=True)


def read_chunks(chunk_ms: int):
    """
    Generator that yields numpy float32 arrays read from stdin in
    `chunk_ms`-duration windows of raw PCM (16 kHz, 16-bit mono LE).

    Stops when stdin reaches EOF.
    """
    chunk_bytes = int(SAMPLE_RATE * chunk_ms / 1000) * BYTES_PER_SAMPLE
    stdin_buf = sys.stdin.buffer

    while True:
        raw = stdin_buf.read(chunk_bytes)
        if not raw:
            return  # EOF
        # Pad if the last chunk is shorter than chunk_bytes
        if len(raw) < chunk_bytes:
            raw = raw + b"\x00" * (chunk_bytes - len(raw))
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        yield audio


def main() -> None:
    parser = argparse.ArgumentParser(description="Pensieve live transcription sidecar")
    parser.add_argument("--model", default="base.en", help="Whisper model name")
    parser.add_argument("--device", default="cpu", help="cpu, cuda, or mps")
    parser.add_argument(
        "--compute-type",
        default="int8",
        dest="compute_type",
        help="float16, int8, float32",
    )
    parser.add_argument(
        "--language",
        default=None,
        help="Language code (None = auto-detect)",
    )
    parser.add_argument(
        "--chunk-ms",
        type=int,
        default=3000,
        dest="chunk_ms",
        help="Audio window size in milliseconds",
    )
    parser.add_argument(
        "--overlap-ms",
        type=int,
        default=500,
        dest="overlap_ms",
        help="Overlap with previous window in milliseconds",
    )
    args = parser.parse_args()

    # Signal that we are alive but still loading the model
    _emit({"type": "status", "status": "loading"})
    _log(f"Loading model '{args.model}' on {args.device} ({args.compute_type})...")

    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError:
        _log("ERROR: faster_whisper is not installed in this venv.")
        _emit({"type": "status", "status": "done"})
        sys.exit(1)

    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
        )
    except Exception as exc:
        _log(f"ERROR loading model: {exc}")
        _emit({"type": "status", "status": "done"})
        sys.exit(1)

    _log("Model loaded; ready for audio.")
    _emit({"type": "status", "status": "active"})

    seq = 0
    overlap_samples = int(SAMPLE_RATE * args.overlap_ms / 1000)
    # Carry buffer: tail of the previous window to smooth boundary artifacts
    carry = np.array([], dtype=np.float32)

    for chunk in read_chunks(args.chunk_ms):
        audio = np.concatenate([carry, chunk]) if carry.size > 0 else chunk

        try:
            segments, info = model.transcribe(
                audio,
                language=args.language,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
            )
            for segment in segments:
                text = segment.text.strip()
                if not text:
                    continue  # skip silence / empty segments
                fragment = {
                    "type": "fragment",
                    "seq": seq,
                    "text": text,
                    "start_ms": int(segment.start * 1000),
                    "end_ms": int(segment.end * 1000),
                    "is_final": True,
                    "language": info.language,
                    "speaker": None,
                }
                _emit(fragment)
                seq += 1
        except Exception as exc:
            _log(f"Transcription error on chunk (seq={seq}): {exc}")

        # Keep tail for overlap on next window
        if overlap_samples > 0:
            carry = audio[-overlap_samples:]
        else:
            carry = np.array([], dtype=np.float32)

    # stdin hit EOF -- flush remaining carry buffer
    _log("EOF on stdin; flushing carry buffer...")
    if carry.size >= SAMPLE_RATE // 4:  # at least 250ms of audio worth flushing
        try:
            segments, info = model.transcribe(
                carry,
                language=args.language,
                vad_filter=True,
            )
            for segment in segments:
                text = segment.text.strip()
                if not text:
                    continue
                fragment = {
                    "type": "fragment",
                    "seq": seq,
                    "text": text,
                    "start_ms": int(segment.start * 1000),
                    "end_ms": int(segment.end * 1000),
                    "is_final": True,
                    "language": info.language,
                    "speaker": None,
                }
                _emit(fragment)
                seq += 1
        except Exception as exc:
            _log(f"Transcription error during final flush: {exc}")

    _log(f"Done. Emitted {seq} fragment(s).")
    _emit({"type": "status", "status": "done"})


if __name__ == "__main__":
    main()
