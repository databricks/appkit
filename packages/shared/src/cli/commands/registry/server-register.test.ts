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
  it("extends an existing import from the same module, idempotently", () => {
    const dir = makeTempDir();
    const file = writeServer(dir, "server.ts", "server()");
    registerPluginInServer(dir, "@databricks/appkit", "analytics");
    registerPluginInServer(dir, "@databricks/appkit", "analytics");
    const out = fs.readFileSync(file, "utf-8");
    expect(out).toContain(
      `import { createApp, analytics } from "@databricks/appkit";`,
    );
    expect(out.match(/@databricks\/appkit"/g)).toHaveLength(1);
    expect(out.match(/analytics\(\)/g)).toHaveLength(1);
  });

  it("extends the /beta import and keeps a multi-line list's layout", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "server.ts");
    fs.writeFileSync(
      file,
      `import { createApp, server } from "@databricks/appkit";\n` +
        `import {\n  agents,\n} from "@databricks/appkit/beta";\n\n` +
        `createApp({ plugins: [server(), agents()] });\n`,
    );
    registerPluginInServer(dir, "@databricks/appkit/beta", "aiSearch");
    const out = fs.readFileSync(file, "utf-8");
    expect(out).toContain(
      `import {\n  agents,\n  aiSearch,\n} from "@databricks/appkit/beta";`,
    );
    expect(out).toContain(
      `import { createApp, server } from "@databricks/appkit";`,
    );
  });

  it("treats a commented `import /* x */ type` as type-only", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "server.ts");
    fs.writeFileSync(
      file,
      `import /* types used below */ type { Plugin } from "@databricks/appkit";\n` +
        `import { createApp } from "@databricks/appkit";\n\n` +
        `createApp({ plugins: [] });\n`,
    );
    registerPluginInServer(dir, "@databricks/appkit", "analytics");
    const out = fs.readFileSync(file, "utf-8");
    expect(out).toContain(
      `import /* types used below */ type { Plugin } from "@databricks/appkit";`,
    );
    expect(out).toContain(
      `import { createApp, analytics } from "@databricks/appkit";`,
    );
  });

  it("adds a new line rather than extending a type-only import", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "server.ts");
    fs.writeFileSync(
      file,
      `import type { PluginData } from "@databricks/appkit/beta";\n` +
        `import { createApp } from "@databricks/appkit";\n\n` +
        `createApp({ plugins: [] });\n`,
    );
    registerPluginInServer(dir, "@databricks/appkit/beta", "agents");
    const out = fs.readFileSync(file, "utf-8");
    expect(out).toContain(
      `import type { PluginData } from "@databricks/appkit/beta";`,
    );
    expect(out).toContain(`import { agents } from "@databricks/appkit/beta";`);
  });

  it("accepts an external npm package and rejects code in the path", () => {
    const dir = makeTempDir();
    writeServer(dir, "server.ts", "server()");
    expect(
      registerPluginInServer(dir, "@example/analytics", "analytics").status,
    ).toBe("wired");
    expect(registerPluginInServer(dir, `x"; evil(); "`, "other").status).toBe(
      "skipped",
    );
  });

  it("passes call args and accepts the AppKit package import path", () => {
    const dir = makeTempDir();
    const file = writeServer(dir, "server.ts", "server()");
    const result = registerPluginInServer(
      dir,
      "@databricks/appkit",
      "files",
      `{ auth: "on-behalf-of-user" }`,
    );
    expect(result.status).toBe("wired");
    const out = fs.readFileSync(file, "utf-8");
    expect(out).toContain(`files({ auth: "on-behalf-of-user" }), server()`);
    expect(out).toContain(
      `import { createApp, files } from "@databricks/appkit";`,
    );
  });

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
    // `hello` is bound by extending the same-path import; HelloPlugin stays.
    expect(written).toContain(
      'import { HelloPlugin, hello } from "./plugins/hello";',
    );
    expect(written).toContain("hello()");
  });

  it("does not add a conflicting import when the binding already exists", () => {
    // The binding `hello` is already imported (from another module) but not yet
    // in the array. De-dup keys on the binding, so no second `hello` import is
    // added — that would be a duplicate declaration. Path-based de-dup would
    // miss this and emit a conflicting `import { hello } from "./plugins/hello"`.
    const dir = makeTempDir();
    const file = path.join(dir, "index.ts");
    fs.writeFileSync(
      file,
      `import { createApp } from "@databricks/appkit";\n` +
        `import { hello } from "./elsewhere";\n\n` +
        `const app = await createApp({ plugins: [] });\n`,
    );

    const result = registerPluginInServer(dir, "./plugins/hello", "hello");

    expect(result.status).toBe("wired");
    const written = fs.readFileSync(file, "utf-8");
    // Exactly one `hello` binding, still the original — no duplicate added.
    expect(written.match(/import \{ hello \} from/g)).toHaveLength(1);
    expect(written).toContain('import { hello } from "./elsewhere";');
    expect(written).not.toContain('import { hello } from "./plugins/hello";');
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
