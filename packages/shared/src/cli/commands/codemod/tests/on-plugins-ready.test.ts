import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { migrateFile } from "../on-plugins-ready";

const fixturesDir = path.join(__dirname, "fixtures");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), "utf-8");
}

describe("onPluginsReady-callback codemod", () => {
  describe("Pattern A: .then() chain", () => {
    test("migrates .then chain without .catch, adds .catch(console.error)", () => {
      const fixturePath = path.join(fixturesDir, "pattern-a.input.ts");
      const result = migrateFile(fixturePath);

      expect(result.migrated).toBe(true);
      expect(result.content).toContain("onPluginsReady(appkit)");
      expect(result.content).not.toContain(".then(");
      expect(result.content).not.toContain(".start()");
      expect(result.content).not.toContain("autoStart");
      expect(result.content).toContain(".catch(console.error)");
      expect(result.content).toContain("server()");
    });

    test("migrates .then chain with existing .catch, preserves it", () => {
      const fixturePath = path.join(
        fixturesDir,
        "pattern-a-with-catch.input.ts",
      );
      const result = migrateFile(fixturePath);

      expect(result.migrated).toBe(true);
      expect(result.content).toContain("onPluginsReady(appkit)");
      expect(result.content).not.toContain(".then(");
      expect(result.content).not.toContain(".start()");
      expect(result.content).toContain(".catch(console.error)");
      expect(result.content).toContain("server()");
    });

    test("preserves the extend callback content", () => {
      const fixturePath = path.join(fixturesDir, "pattern-a.input.ts");
      const result = migrateFile(fixturePath);

      expect(result.content).toContain('app.get("/custom"');
      expect(result.content).toContain("res.json({ ok: true })");
    });

    test("preserves arrow function .catch handler with parens", () => {
      const fixturePath = path.join(
        fixturesDir,
        "pattern-a-arrow-catch.input.ts",
      );
      const result = migrateFile(fixturePath);

      expect(result.migrated).toBe(true);
      expect(result.content).toContain(".catch((err) => console.error(err))");
      expect(result.content).not.toContain(".then(");
      expect(result.content).not.toContain(".start()");
    });
  });

  describe("Pattern B: await + imperative", () => {
    test("migrates await pattern with extend + start", () => {
      const fixturePath = path.join(fixturesDir, "pattern-b.input.ts");
      const result = migrateFile(fixturePath);

      expect(result.migrated).toBe(true);
      expect(result.content).toContain("onPluginsReady(appkit)");
      expect(result.content).not.toContain("appkit.server.start()");
      expect(result.content).not.toContain("autoStart");
      expect(result.content).toContain("server()");
    });

    test("bails out when non-server usage of appkit handle exists", () => {
      const fixturePath = path.join(fixturesDir, "pattern-b-complex.input.ts");
      const result = migrateFile(fixturePath);

      expect(result.warnings.some((w) => w.includes("migrate manually"))).toBe(
        true,
      );
      expect(result.content).toContain("server()");
      expect(result.content).not.toContain("autoStart");
    });

    test("bails out when multiple .extend() calls exist", () => {
      const fixturePath = path.join(
        fixturesDir,
        "pattern-b-multi-extend.input.ts",
      );
      const result = migrateFile(fixturePath);

      expect(result.warnings.some((w) => w.includes("migrate manually"))).toBe(
        true,
      );
      expect(result.content).toContain("server()");
      expect(result.content).not.toContain("autoStart");
    });
  });

  describe("autoStart stripping", () => {
    test("strips autoStart: true and preserves other config", () => {
      const fixturePath = path.join(
        fixturesDir,
        "autostart-true-with-port.input.ts",
      );
      const result = migrateFile(fixturePath);

      expect(result.migrated).toBe(true);
      expect(result.content).not.toContain("autoStart");
      expect(result.content).toContain("port: 3000");
      expect(result.content).toContain("server({");
    });
  });

  describe("idempotency", () => {
    test("no-ops on already migrated file", () => {
      const fixturePath = path.join(fixturesDir, "already-migrated.input.ts");
      const result = migrateFile(fixturePath);

      expect(result.migrated).toBe(false);
      expect(result.warnings.some((w) => w.includes("Already migrated"))).toBe(
        true,
      );
      expect(result.content).toBe(readFixture("already-migrated.input.ts"));
    });
  });
});
