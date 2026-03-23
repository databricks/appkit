import { execSync } from "node:child_process";

const cache = new Map<string, string | null>();

export function whichBinary(name: string): string | null {
  if (cache.has(name)) return cache.get(name)!;

  const command =
    process.platform === "win32" ? `where ${name}` : `which ${name}`;
  try {
    const result = execSync(command, { encoding: "utf8", timeout: 3000 })
      .trim()
      .split("\n")[0];
    cache.set(name, result || null);
    return result || null;
  } catch {
    cache.set(name, null);
    return null;
  }
}
