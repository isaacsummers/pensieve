import path from "path";

export const getExtraResourcesFolder = () => {
  return process.env.NODE_ENV === "development"
    ? path.join(__dirname, "../../extra")
    : path.join(process.resourcesPath, "extra");
};

export const getMillisecondsFromTimeString = (time: string) => {
  if (!time) return 0;
  const [h, m, s, ms] = time.split(/[:.]/).map(Number);
  return (h * 60 * 60 + m * 60 + s) * 1000 + ms;
};

export const buildArgs = (
  argMap: Record<string, boolean | null | number | string>,
) => {
  const args: string[] = [];
  for (const [keyRaw, value] of Object.entries(argMap)) {
    const key = keyRaw.startsWith("-")
      ? keyRaw
      : keyRaw.length === 1
        ? `-${keyRaw}`
        : `--${keyRaw}`;
    if (keyRaw.startsWith("_")) {
      args.push(String(value));
    } else if (value === false || value === null || value === undefined) {
      // Explicit skip: a flag is omitted only if its value is an opt-out
      // sentinel. Previously this branch used truthiness and would silently
      // drop `0` or empty strings — a real footgun for numeric flags.
      if (value === null) {
        args.push(key);
      }
      // false / undefined => NOOP
    } else if (value === true) {
      args.push(key);
    } else {
      args.push(key, String(value));
    }
  }
  return args;
};

export const getIconPath = () =>
  path.join(getExtraResourcesFolder(), "icon.png");
