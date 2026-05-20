import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reactSourceLocPlugin } from "../react-source-loc-vite-plugin";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.join(testDir, "client");
const projectRoot = testDir;
const moduleId = path.join(clientRoot, "src", "Example.tsx");

interface TestableHooks {
  transform?: (
    code: string,
    id: string,
  ) =>
    | { code: string }
    | string
    | null
    | undefined
    | Promise<{ code: string } | string | null | undefined>;
}

async function transformSource(
  code: string,
  root: string = clientRoot,
  id: string = moduleId,
  rootForPaths: string = projectRoot,
): Promise<string> {
  const { transform } = reactSourceLocPlugin({
    projectRoot: rootForPaths,
  }) as unknown as TestableHooks;

  const result = await transform?.(code, id);
  if (!result) return code;
  return typeof result === "string" ? result : result.code;
}

describe("reactSourceLocPlugin", () => {
  it("injects data-source on native opening and self-closing tags", async () => {
    const code = `export function App() {
  return (
    <motion.div>
      <div className="a">
        <span />
      </div>
    </motion.div>
  );
}
`;
    const output = await transformSource(code);
    expect(output).toContain('data-source="client/src/Example.tsx:');
    expect(output).toMatch(/<motion\.div>/);
    expect(output).toMatch(/<div data-source="[^"]+" className="a">/);
    expect(output).toMatch(/<span data-source="[^"]+" \/>/);
    expect(output).not.toContain("motion.div data-source");
  });

  it("skips components, fragments, namespaced tags, and existing data-source", async () => {
    const code = `export function App() {
  return (
  <>
    <Foo />
    <Foo.Bar />
    <svg:circle />
    <motion.div data-source="manual" />
  </>
  );
}
`;
    const output = await transformSource(code);
    expect(output).not.toMatch(/<Foo data-source=/);
    expect(output).not.toMatch(/<Foo\.Bar data-source=/);
    expect(output).not.toMatch(/<svg:circle data-source=/);
    expect(output).toContain('<motion.div data-source="manual"');
    expect(output).not.toMatch(/data-source="[^"]+" data-source=/);
  });

  it("resolves paths from app root when vite root is the app root", async () => {
    const appRoot = path.join(testDir, "flat-app");
    const flatModuleId = path.join(appRoot, "src", "Page.tsx");
    const code = `export const Page = () => <div className="x" />;`;

    const output = await transformSource(code, appRoot, flatModuleId, appRoot);

    expect(output).toMatch(/<div data-source="src\/Page\.tsx:/);
    expect(output).not.toMatch(/data-source="[^"]*\.\./);
  });
});
