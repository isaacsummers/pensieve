import { app, protocol } from "electron";
import path from "path";
import fs from "fs-extra";
import { updateElectronApp } from "update-electron-app";
import log from "electron-log/main";
import started from "electron-squirrel-startup";
import http from "http";
import getPort from "get-port";
import { loadIpcInterfaceInMain } from "./main/ipc/ipc-connector";
import { mainApi } from "./main/ipc/main-api";
import { modelsApi } from "./main/ipc/models-api";
import { whisperxApi } from "./main/ipc/whisperx-api";
import { ffmpegApi } from "./main/ipc/ffmpeg-api";
import { historyApi } from "./main/ipc/history-api";
import { speakerProfilesApi } from "./main/ipc/speaker-profiles-api";
import { llmApi } from "./main/ipc/llm-api";
import * as history from "./main/domain/history";
import * as searchIndex from "./main/domain/search";
import * as settings from "./main/domain/settings";
import { registerTray } from "./main/domain/tray";
import * as windows from "./main/domain/windows";
import { windowsApi } from "./main/ipc/windows-api";
import { recorderIpcApi } from "./main/ipc/recorder-ipc";
import {
  getAudioServerSecret,
  setAudioServerPort,
} from "./main/domain/audio-server";

log.initialize({ spyRendererConsole: true });

// Electron apps launched from Finder/Spotlight (macOS) or by the Squirrel
// shim (Windows) don't inherit the user's interactive shell PATH, so tools
// like `uv` installed under `~/.cargo/bin`, `~/.local/bin`, or Homebrew's
// `/opt/homebrew/bin` are invisible to `execa`. Probe a small set of known
// install locations and prepend whichever one we find to process.env.PATH
// so subsequent `uv sync` / `uv tool dir` calls resolve correctly. Done
// before any IPC handler registration so the first probe call from the
// renderer sees the patched env.
((): void => {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return;
  const exe = process.platform === "win32" ? "uv.exe" : "uv";
  const candidates = [
    path.join(home, ".cargo", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const sep = process.platform === "win32" ? ";" : ":";
  const currentPath = process.env.PATH ?? "";
  const seen = new Set(currentPath.split(sep).filter(Boolean));
  const toPrepend: string[] = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    if (fs.existsSync(path.join(dir, exe))) {
      toPrepend.push(dir);
      seen.add(dir);
    }
  }
  if (toPrepend.length > 0) {
    process.env.PATH = [...toPrepend, currentPath].filter(Boolean).join(sep);
    log.info(
      `[startup] prepended uv search dirs to PATH: ${toPrepend.join(", ")}`,
    );
  }
})();

updateElectronApp();

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const mainWindow = windows.getMainWindow();
    if (!mainWindow) {
      return;
    }
    if (!windows.isMainWindowOpen()) {
      windows.openMainWindowNormally();
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
// eslint-disable-next-line global-require
if (started) {
  app.quit();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: "recording",
    privileges: {
      bypassCSP: true,
      // supportFetchAPI: true,
      // secure: true,
      stream: true,
    },
  },
]);

app.whenReady().then(async () => {
  await history.init();
  loadIpcInterfaceInMain("main", mainApi);
  loadIpcInterfaceInMain("windows", windowsApi);
  loadIpcInterfaceInMain("history", historyApi);
  loadIpcInterfaceInMain("models", modelsApi);
  loadIpcInterfaceInMain("whisperx", whisperxApi);
  loadIpcInterfaceInMain("ffmpeg", ffmpegApi);
  loadIpcInterfaceInMain("speakerProfiles", speakerProfilesApi);
  loadIpcInterfaceInMain("llm", llmApi);
  loadIpcInterfaceInMain("recorderIpc", recorderIpcApi);

  searchIndex.initializeSearchIndex().then(() => {
    log.info("Search index initialized.");
  });

  if (!settings.existsSettingsFile()) {
    await settings.initSettingsFile();
    await mainApi.setAutoStart(true);
  }

  // Start a local HTTP server for audio files
  const audioServer = http.createServer(async (req, res) => {
    if (req.url?.startsWith("/audio/")) {
      // Check for auth secret in query parameters
      const url = new URL(req.url, `http://localhost`);
      const providedSecret = url.searchParams.get("auth");
      const expectedSecret = getAudioServerSecret();

      if (
        !providedSecret ||
        !expectedSecret ||
        providedSecret !== expectedSecret
      ) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      const recordingId = url.pathname.replace("/audio/", "");
      const mp3 = path.join(
        await history.getRecordingsFolder(),
        recordingId,
        "recording.mp3",
      );

      if (!fs.existsSync(mp3)) {
        res.writeHead(404);
        res.end("Audio not found");
        return;
      }

      const stat = fs.statSync(mp3);
      const fileSize = stat.size;
      const { range } = req.headers;

      console.log(`Audio request: ${req.url}, Range: ${range || "none"}`);

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = end - start + 1;

        console.log(`Range request: ${start}-${end} (${chunksize} bytes)`);

        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunksize,
          "Content-Type": "audio/mpeg",
        });

        const stream = fs.createReadStream(mp3, { start, end });
        stream.pipe(res);
      } else {
        console.log(`Full file request: ${fileSize} bytes`);
        res.writeHead(200, {
          "Content-Length": fileSize,
          "Content-Type": "audio/mpeg",
          "Accept-Ranges": "bytes",
        });

        const stream = fs.createReadStream(mp3);
        stream.pipe(res);
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  // Start the audio server on a dynamic port
  const audioPort = await getPort({ port: 3001 });
  setAudioServerPort(audioPort);
  audioServer.listen(audioPort, () => {
    console.log(`Audio server running on port ${audioPort}`);
  });

  // Keep the original protocol for backward compatibility
  protocol.registerFileProtocol("recording", async (request, callback) => {
    const recordingId = request.url.replace("recording://", "");
    const mp3 = path.join(
      await history.getRecordingsFolder(),
      recordingId,
      "recording.mp3",
    );
    if (fs.existsSync(mp3)) {
      callback({ path: mp3 });
    } else {
      console.error(`Recording audio not found: ${mp3}`);
      callback({ statusCode: 404 });
    }
  });

  protocol.registerFileProtocol("screenshot", async (request, callback) => {
    const fileName = request.url.replace("screenshot://", "");

    if (!/^[\w-_]+\/[\w]+\.png$/.test(fileName)) {
      console.error(`Invalid image loaded: ${fileName}`);
      callback({ statusCode: 400 });
      return;
    }

    const imageFile = path.join(await history.getRecordingsFolder(), fileName);
    if (fs.existsSync(imageFile)) {
      callback({ path: imageFile });
    } else {
      console.error(`Image not found: ${fileName}`);
      callback({ statusCode: 404 });
    }
  });

  windows.initializeMainWindow();

  const hidden = process.argv.join(" ").includes("hidden");
  log.info(
    `App ready, running ${hidden ? "hidden" : "normally"}. Args: ${process.argv.join(" ")}`,
  );
  if (!hidden) {
    windows.openMainWindowNormally();
  } else {
    // windows.hideMainWindow();
  }
  registerTray();
});
