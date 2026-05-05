import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerDMG } from "@electron-forge/maker-dmg";
// import { MakerAppX } from "@electron-forge/maker-appx";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import fs from "fs-extra";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";
// Note: ffmpeg is NOT bundled by the build system. Users must supply it
// via the Dependencies panel (Windows) or their system package manager.

// Pinned uv version. Bumping this is the trigger for a re-download on the
// next build (we compare against extra/uv-version.txt and skip the download
// when it matches the existing binary).
const UV_VERSION = "0.6.16";

const getUvAssetForPlatform = (): {
  url: string;
  archive: string;
  binary: string;
} => {
  const { platform } = process;
  const { arch } = process;
  const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
  if (platform === "win32" && arch === "x64") {
    return {
      url: `${base}/uv-x86_64-pc-windows-msvc.zip`,
      archive: "uv.zip",
      binary: "uv.exe",
    };
  }
  if (platform === "darwin" && arch === "arm64") {
    return {
      url: `${base}/uv-aarch64-apple-darwin.tar.gz`,
      archive: "uv.tar.gz",
      binary: "uv",
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return {
      url: `${base}/uv-x86_64-apple-darwin.tar.gz`,
      archive: "uv.tar.gz",
      binary: "uv",
    };
  }
  if (platform === "linux" && arch === "x64") {
    return {
      url: `${base}/uv-x86_64-unknown-linux-gnu.tar.gz`,
      archive: "uv.tar.gz",
      binary: "uv",
    };
  }
  if (platform === "linux" && arch === "arm64") {
    return {
      url: `${base}/uv-aarch64-unknown-linux-gnu.tar.gz`,
      archive: "uv.tar.gz",
      binary: "uv",
    };
  }
  throw new Error(
    `No prebuilt uv binary configured for ${platform}/${arch}. Add a mapping in forge.config.ts.`,
  );
};

/**
 * Download + extract the uv release asset for the build host's platform
 * into `extra/`. We bundle uv so the packaged app can manage the WhisperX
 * Python project without requiring users to install uv system-wide.
 *
 * Skips the download when extra/uv-version.txt matches UV_VERSION and the
 * binary still exists — cheap re-runs of `generateAssets`.
 */
const downloadUv = async (extraDir: string): Promise<void> => {
  const { url, archive, binary } = getUvAssetForPlatform();
  const versionFile = path.join(extraDir, "uv-version.txt");
  const binaryPath = path.join(extraDir, binary);

  if (
    (await fs.pathExists(versionFile)) &&
    (await fs.pathExists(binaryPath)) &&
    (await fs.readFile(versionFile, "utf-8")).trim() === UV_VERSION
  ) {
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pensieve-uv-"));
  try {
    const archivePath = path.join(tmpDir, archive);
    // eslint-disable-next-line no-console
    console.log(`[uv] downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`uv download failed (${res.status} ${res.statusText})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(archivePath, buf);

    // bsdtar (shipped on Win10+, macOS, Linux) handles .tar.gz natively,
    // but Git Bash's tar on Windows can't unpack .zip — use PowerShell's
    // Expand-Archive there instead.
    if (process.platform === "win32" && archive.endsWith(".zip")) {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tmpDir}' -Force"`,
        { stdio: "inherit" },
      );
    } else {
      execSync(`tar -xf "${archivePath}" -C "${tmpDir}"`, {
        stdio: "inherit",
      });
    }

    // Locate the extracted binary (may sit at the archive root or nested
    // under a release-name directory).
    const findBinary = async (dir: string): Promise<string | null> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isFile() && e.name === binary) return full;
        if (e.isDirectory()) {
          const nested = await findBinary(full);
          if (nested) return nested;
        }
      }
      return null;
    };
    const extracted = await findBinary(tmpDir);
    if (!extracted) {
      throw new Error(
        `uv binary "${binary}" not found in extracted ${archive}`,
      );
    }
    await fs.copy(extracted, binaryPath, { overwrite: true });
    if (process.platform !== "win32") {
      await fs.chmod(binaryPath, 0o755);
    }
    await fs.writeFile(versionFile, UV_VERSION, "utf-8");
    // eslint-disable-next-line no-console
    console.log(`[uv] bundled ${binary} ${UV_VERSION} into ${extraDir}`);
  } finally {
    await fs.remove(tmpDir).catch(() => {});
  }
};

const createIcon = async (factor: number, base = 32) => {
  const source = await fs.readFile(path.join(__dirname, "./icon.svg"), "utf-8");
  const resvg = new Resvg(source, {
    background: "transparent",
    fitTo: { mode: "width", value: base * factor },
  });
  const png = resvg.render();
  await fs.writeFile(
    path.join(
      __dirname,
      "extra",
      factor === 1 ? "icon.png" : `icon@${factor}x.png`,
    ),
    png.asPng() as any,
  );
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: "*.{node,dll,exe}",
    },
    extraResource: ["./extra", "./scripts"],
    icon: "./extra/icon@8x.ico",
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      loadingGif: path.join(__dirname, "splash.gif"),
      setupIcon: "./extra/icon@8x.ico",
    }),
    // new MakerAppX({}),
    new MakerZIP({}, ["darwin"]),
    new MakerRpm({}),
    new MakerDeb({}),
    new MakerDMG({
      icon: "./extra/icon@8x.ico",
    }),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),

    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],

  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: "lukasbach",
          name: "pensieve",
        },
        prerelease: false,
        draft: true,
        generateReleaseNotes: true,
      },
    },
  ],

  hooks: {
    generateAssets: async () => {
      // generateAssets runs during both `electron-forge start` and
      // `... package` / `... make`. We only want the heavy downloads
      // (uv) during a real build — dev iterations should be fast.
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.log(
          "[generateAssets] dev mode (NODE_ENV != production) — skipping uv download / icon regen",
        );
        return;
      }

      const target = path.join(__dirname, "extra");
      await fs.ensureDir(target);

      await createIcon(1);
      await createIcon(2);
      await createIcon(3);
      await createIcon(4);
      await createIcon(8);
      await pngToIco(path.join(__dirname, "extra/icon@8x.png")).then((buf) =>
        fs.writeFileSync(path.join(__dirname, "extra/icon@8x.ico"), buf as any),
      );

      // Bundle the WhisperX uv project's pyproject.toml into extraResources
      // so the packaged app can copy it into userData and run `uv sync`.
      // Renamed to avoid colliding with the app's own (root) pyproject if
      // anything ever lands at extra/pyproject.toml.
      await fs.copy(
        path.join(__dirname, "python", "pyproject.toml"),
        path.join(__dirname, "extra", "whisperx-pyproject.toml"),
        { overwrite: true },
      );

      // Download + bundle uv so the packaged app doesn't depend on a
      // system-wide uv install.
      await downloadUv(target);
    },
  },
};

export default config;
