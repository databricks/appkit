import fs from "node:fs";
import path from "node:path";

interface CodexTools {
  /** The Codex binary from the app's `@openai/codex` package. */
  bin?: string;
  /** A usable `bwrap`, to sandbox it. */
  bwrap?: string;
}

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (dir) return p;
    } catch {}
  }
  return undefined;
}

/** Finds the Codex binary (to wrap it) and bubblewrap (PATH, else the one Codex's package ships). */
export function findCodex(appDir: string): CodexTools {
  const nm = path.join(appDir, "node_modules", "@openai");
  let bin: string | undefined;
  // vendor/<triple>/bin/codex (0.15x+) or vendor/<triple>/codex/codex (older).
  for (const pkg of readdir(nm).filter((d) => d.startsWith("codex-"))) {
    for (const triple of readdir(path.join(nm, pkg, "vendor"))) {
      const base = path.join(nm, pkg, "vendor", triple);
      bin =
        [
          path.join(base, "bin", "codex"),
          path.join(base, "codex", "codex"),
        ].find((p) => fs.existsSync(p)) ?? bin;
    }
  }
  let bwrap = onPath("bwrap");
  if (!bwrap && bin) {
    const shipped = path.resolve(
      path.dirname(bin),
      "..",
      "codex-resources",
      "bwrap",
    );
    if (fs.existsSync(shipped)) {
      fs.chmodSync(shipped, 0o755);
      bwrap = shipped;
    }
  }
  return { bin, bwrap };
}
