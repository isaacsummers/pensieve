import * as ffmpeg from "../domain/ffmpeg";
import * as settingsDomain from "../domain/settings";

export const ffmpegApi = {
  getStatus: async (): Promise<ffmpeg.FfmpegStatus> => {
    return ffmpeg.detectFfmpeg();
  },

  /**
   * "Use existing" \u2014 copy the detected/user-specified binary into extra/ so
   * the bundled-path resolver finds it. Returns the new target path.
   */
  useExisting: async (
    sourcePath: string,
  ): Promise<{ ok: boolean; target?: string; error?: string }> => {
    const result = await ffmpeg.adoptExternalFfmpeg(sourcePath);
    return result;
  },

  /**
   * Persist an explicit binary path in settings (skips the copy). Useful when
   * the user wants to keep ffmpeg where it lives, e.g. C:\\ffmpeg\\bin.
   */
  setConfiguredPath: async (binaryPath: string): Promise<void> => {
    const s = await settingsDomain.getSettings();
    await settingsDomain.saveSettings({
      ...s,
      ffmpeg: { ...s.ffmpeg, binaryPath },
    });
    ffmpeg.invalidateFfmpegCache();
  },

  /**
   * "Download latest" \u2014 TODO: implement automated BtbN download + extract to
   * extra/ffmpeg.exe. For now, open the releases page and let the user drop
   * the binary into C:\\ffmpeg\\bin (which autodetect handles).
   */
  openDownloadPage: async (): Promise<void> => {
    const { shell } = await import("electron");
    await shell.openExternal(
      "https://github.com/BtbN/FFmpeg-Builds/releases/latest",
    );
  },
};
