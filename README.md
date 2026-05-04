# Pensieve

> Desktop app for recording meetings or memos from locally running apps and transcribing and summarizing them with a local LLM

<div align="center">
    <a href="https://github.com/lukasbach/pensieve/releases/latest">
        Download the latest release
    </a>
</div>
<br />

# API for desktop recording

If you’re looking for a hosted desktop recording API, consider checking out [Recall.ai](https://www.recall.ai/?utm_source=github&utm_medium=sponsorship&utm_campaign=pensieve), an API that records Zoom, Google Meet, Microsoft Teams, In-person meetings, and more.

# Pensieve App

<div align="center">
    <img src="https://github.com/lukasbach/pensieve/raw/main/images/preview.png" alt="Preview image of Pensieve" />
</div>
<br />

Pensieve is a local-only desktop app for recording meetings, discussions, memos or other audio
snippets from locally running applications for you to always go back and review your
previous discussions.

It uses [WhisperX](https://github.com/m-bain/whisperX) to transcribe audio locally
(with optional pyannote-based speaker diarization), and optionally summarizes the
transcriptions with an LLM. You can connect a local Ollama instance to
be used for summarization, or provide an OpenAI key and have ChatGPT summarize the
transcriptions for you.

If you choose Ollama for summarization (or disable summarization entirely), all your
data stays on your machine and is never sent to any external service. You can record
as many meetings as you want, and manage your data yourself without any external
providers involved.

Pensieve automatically registers a tray icon and runs in the background, which
makes it easy to start and stop recordings at any time. You can also configure
Pensieve in many ways, like customizing which models to use for transcription
and summarization, or various audio processing settings.

<div align="center">
    <a href="https://github.com/lukasbach/pensieve/releases/latest">
        Download the latest release
    </a>
</div>


# MacOS Setup Notes

Pensieve requires FFmpeg and Whisper to be installed on macOS. The easiest way to install these dependencies is using Homebrew:

### Prerequisites

1. **Install Homebrew** (if not already installed):
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```

2. **Install FFmpeg**:
   ```bash
   brew install ffmpeg
   ```

3. **Install Whisper**:
   ```bash
   brew install whisper-cpp
   ```

### Verification

After installation, verify that both tools are available:

```bash
ffmpeg -version
whisper-cpp --help
```

### Alternative Installation Methods

If you prefer not to use Homebrew:

- **FFmpeg**: Download from [https://ffmpeg.org/download.html](https://ffmpeg.org/download.html)
- **Whisper**: Download from [https://github.com/ggerganov/whisper.cpp](https://github.com/ggerganov/whisper.cpp)

### Troubleshooting

If Pensieve shows warning dialogs about missing dependencies:
1. Ensure the tools are installed and available in your PATH
2. Restart Pensieve after installation
3. Check that the tools are accessible from the terminal

## Issue reporting

If you encounter any issues or bugs with Pensieve, please report them as issue.
Please provide the log files from your local installation, which is stored in
the `%USERPROFILE%\AppData\Roaming\Pensieve\logs\main.log` folder.

## Setup — WhisperX transcription

Pensieve shells out to the [WhisperX](https://github.com/m-bain/whisperX) CLI
for transcription, forced word alignment, and (optionally) pyannote speaker
diarization. WhisperX is **not bundled** — install it yourself once per
machine:

### Windows (recommended: `uv`)

1. Install [uv](https://docs.astral.sh/uv/).
2. `uv tool install whisperx`
3. Confirm `whisperx --help` works in a new terminal.

For NVIDIA GPU support, install a matching CUDA build of PyTorch into the
WhisperX tool environment before first use. CPU-only is supported (set
**Compute type** to `int8` and **Device** to `cpu` in settings).

### macOS / Linux

- `pipx install whisperx` (or `uv tool install whisperx`).
- Verify `whisperx --help`.

### Diarization (optional)

WhisperX uses pyannote models for speaker diarization. To enable it:

1. Accept the terms at
   <https://huggingface.co/pyannote/speaker-diarization-3.1> and
   <https://huggingface.co/pyannote/segmentation-3.0>.
2. Generate a **read** token at <https://huggingface.co/settings/tokens>.
3. Paste the token into Pensieve → Settings → Audio Transcription → Hugging
   Face token.

The first transcription will download the selected Faster-Whisper model (and
diarization models if enabled) into your Hugging Face cache. Expect a slower
first run.

### Migration from older Pensieve releases

The previous whisper.cpp backend and its bundled `whisper.exe` are gone.
Existing `whisper.*` entries in `settings.json` are ignored; the new
`whisperx.*` block is populated with defaults on first launch.

### Speaker embedding pipeline

Pensieve can extract voice embeddings for each diarized speaker and match them
against saved profiles. This requires three Python packages: `resemblyzer`,
`librosa`, and `numpy`.

**These are installed automatically.** The first time the embedding pipeline
runs (or when the "Test embedding pipeline" button is clicked in Settings and
dependencies are missing), Pensieve will install them automatically.

Progress is shown in the Settings panel. No manual `pip install` step is
needed.

**Windows note:** `resemblyzer` normally pulls in `webrtcvad` as a dependency,
which requires C++ Build Tools to compile from source. Pensieve's auto-install
works around this by installing `resemblyzer` with `--no-deps` so that
`webrtcvad` is never fetched. **C++ Build Tools are not required.** If you
need to install manually, use:

```
uv pip install --system numpy librosa resemblyzer --no-deps
uv pip install --system umap-learn
```

**macOS / Linux:** `webrtcvad` ships pre-built wheels, so a normal install
works fine:

```
pip install numpy librosa resemblyzer
```

For `yarn make` Windows installer builds: the auto-install runs on first use,
so end-users do not need to run any pip commands manually.
