import fs from "node:fs/promises";
import path from "node:path";

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(scriptDir, "..");
const rootDir = path.resolve(repoRoot, "packages", "appkit-ui", "src", "react", "ui");

async function* walk(dir) {
  for await (const dirent of await fs.opendir(dir)) {
    const res = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield* walk(res);
    } else if (dirent.isFile() && res.endsWith(".tsx")) {
      yield res;
    }
  }
}

function extractClasses(content) {
  const classes = new Set();
  const regex = /["'`](.+?)["'`]/gs;
  for (const match of content.matchAll(regex)) {
    const value = match[1];
    if (!/[a-z0-9]/i.test(value)) continue;
    for (const token of value.split(/\s+/)) {
      if (!token) continue;
      if (/^[a-z][a-z0-9-:/]*$/i.test(token) && /[-:]/.test(token)) {
        classes.add(token);
      }
    }
  }
  return classes;
}

async function main() {
  const safelist = new Set();
  const cwd = rootDir;
  for await (const file of walk(cwd)) {
    const content = await fs.readFile(file, "utf8");
    for (const token of extractClasses(content)) {
      safelist.add(token);
    }
  }

  const docPath = process.argv[2];
  if (!docPath) {
    throw new Error("Please provide output path for safelist JSON");
  }

  await fs.writeFile(docPath, JSON.stringify([...safelist].sort(), null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

