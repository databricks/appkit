import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerPluginInServer } from "./server-register";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "server-register-"));
  tempDirs.push(dir);
  return dir;
}

/** Writes a server entry with a createApp({ plugins: [...] }) call. */
function writeServer(dir: string, rel: string, plugins = ""): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `import { createApp } from "@databricks/appkit";\n\n` +
      `const app = await createApp({ plugins: [${plugins}] });\n`,
  );
  return file;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  tempDirs.length = 0;
});

describe("registerPluginInServer", () => {
  it("wires a plugin into a server root that is a subdir (e.g. api/)", () => {
    // The server root is the resolved subdir, not the repo root — entry files
    // are looked up within it, so an app laid out under api/ still gets wired.
    const dir = makeTempDir();
    const serverRoot = path.join(dir, "api");
    writeServer(serverRoot, "index.ts");

    const result = registerPluginInServer(
      serverRoot,
      "./plugins/hello",
      "hello",
    );

    expect(result.status).toBe("wired");
    expect(result.file).toBe("index.ts");
    const written = fs.readFileSync(path.join(serverRoot, "index.ts"), "utf-8");
    expect(written).toContain('import { hello } from "./plugins/hello";');
    expect(written).toContain("hello()");
  });

  it("finds an entry under src/ within the server root", () => {
    const dir = makeTempDir();
    writeServer(dir, "src/server.ts");

    const result = registerPluginInServer(dir, "./plugins/hello", "hello");

    expect(result.status).toBe("wired");
    expect(result.file).toBe(path.join("src", "server.ts"));
  });

  it("is idempotent — reports already-registered without duplicating", () => {
    const dir = makeTempDir();
    writeServer(dir, "index.ts", "hello()");

    const result = registerPluginInServer(dir, "./plugins/hello", "hello");

    expect(result.status).toBe("already");
    const written = fs.readFileSync(path.join(dir, "index.ts"), "utf-8");
    expect(written.match(/hello\(\)/g)).toHaveLength(1);
  });

  it("adds the import when the same path is imported under a different binding", () => {
    // Regression: import de-dup must key on the binding, not the module path.
    // An existing `import { HelloPlugin } from "./plugins/hello"` (different
    // local name, not in the plugins array) must not suppress the `hello`
    // import, or the added `hello()` element references an unimported symbol.
    const dir = makeTempDir();
    const file = path.join(dir, "index.ts");
    fs.writeFileSync(
      file,
      `import { createApp } from "@databricks/appkit";\n` +
        `import { HelloPlugin } from "./plugins/hello";\n\n` +
        `const app = await createApp({ plugins: [] });\n`,
    );

    const result = registerPluginInServer(dir, "./plugins/hello", "hello");

    expect(result.status).toBe("wired");
    const written = fs.readFileSync(file, "utf-8");
    expect(written).toContain('import { hello } from "./plugins/hello";');
    expect(written).toContain("hello()");
    // The pre-existing, differently-named import is left intact.
    expect(written).toContain('import { HelloPlugin } from "./plugins/hello";');
  });

  it("does not duplicate the import when the binding already exists", () => {
    // The binding `hello` is already imported but not yet in the array — wire
    // the array element without adding a second (conflicting) import.
    const dir = makeTempDir();
    const file = path.join(dir, "index.ts");
    fs.writeFileSync(
      file,
      `import { createApp } from "@databricks/appkit";\n` +
        `import { hello } from "./plugins/hello";\n\n` +
        `const app = await createApp({ plugins: [] });\n`,
    );

    const result = registerPluginInServer(dir, "./plugins/hello", "hello");

    expect(result.status).toBe("wired");
    const written = fs.readFileSync(file, "utf-8");
    expect(written.match(/import \{ hello \} from/g)).toHaveLength(1);
    expect(written).toContain("hello()");
  });

  it("skips (for a printed fallback) when there is no server entry", () => {
    const dir = makeTempDir();
    const result = registerPluginInServer(dir, "./plugins/hello", "hello");
    expect(result.status).toBe("skipped");
  });

  it("skips when the entry has no createApp plugins array", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "index.ts"), "const x = 1;\n");
    const result = registerPluginInServer(dir, "./plugins/hello", "hello");
    expect(result.status).toBe("skipped");
  });

  it("refuses an export name that is not a plain identifier", () => {
    const dir = makeTempDir();
    writeServer(dir, "index.ts");
    const result = registerPluginInServer(dir, "./plugins/x", "evil()); x(");
    expect(result.status).toBe("skipped");
  });
});
