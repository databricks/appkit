import { globSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  renderTemplateConditionals,
  type TemplateVars,
} from "./template-render";

const root = resolve(import.meta.dirname, "..");
const template = join(root, "template");

describe("renderTemplateConditionals", () => {
  const render = (source: string, vars: TemplateVars = {}) =>
    renderTemplateConditionals(source, vars);

  test("renders plugin conditionals", () => {
    const source = "a{{if .plugins.analytics}}b{{end}}c";
    expect(render(source, { plugins: { analytics: {} } })).toBe("abc");
    expect(render(source, { plugins: {} })).toBe("ac");
  });

  test("applies trim markers", () => {
    const source = "a\n{{- if .plugins.x}}\nb\n{{- end}}\nc";
    expect(render(source, { plugins: { x: {} } })).toBe("a\nb\nc");
    expect(render(source)).toBe("a\nc");
    expect(render("{{if .plugins.x -}}\n  b\n{{- end}}\n", {})).toBe("\n");
  });

  test("evaluates not, and, or and parentheses with Go truthiness", () => {
    const vars = { plugins: { a: {} }, appEnv: "", skipExamples: true };
    expect(render("{{if not .skipExamples}}x{{end}}", vars)).toBe("");
    expect(render("{{if not .skipExamples}}x{{end}}", {})).toBe("x");
    expect(
      render("{{if and .plugins.a (not .skipExamples)}}x{{end}}", {}),
    ).toBe("");
    expect(
      render("{{if and .plugins.a (not .skipExamples)}}x{{end}}", {
        plugins: { a: {} },
      }),
    ).toBe("x");
    expect(render("{{if or .appEnv .plugins.b}}x{{end}}", vars)).toBe("");
    expect(render("{{if or .appEnv .plugins.a}}x{{end}}", vars)).toBe("x");
  });

  test("picks the first matching branch of an else-if chain", () => {
    const source = "{{if .plugins.a}}A{{else if .plugins.b}}B{{else}}C{{end}}";
    expect(render(source, { plugins: { a: {}, b: {} } })).toBe("A");
    expect(render(source, { plugins: { b: {} } })).toBe("B");
    expect(render(source, { plugins: {} })).toBe("C");
  });

  test("keeps other actions verbatim but renders conditionals nested in them", () => {
    const source =
      "{{- if .bundle.x}}{{.projectName}}{{- if .plugins.a}}A{{- end}}{{- end}}";
    expect(render(source, { plugins: {} })).toBe(
      "{{- if .bundle.x}}{{.projectName}}{{- end}}",
    );
    expect(
      render(
        '{{range $n, $p := .plugins}}{{if eq $p.S "beta"}}b{{end}}{{end}}',
      ),
    ).toBe('{{range $n, $p := .plugins}}{{if eq $p.S "beta"}}b{{end}}{{end}}');
  });

  test("rejects unbalanced blocks", () => {
    expect(() => render("{{if .plugins.a}}x")).toThrow(/Unclosed/);
    expect(() => render("x{{end}}")).toThrow(/Unexpected/);
  });
});

describe("template scaffold", () => {
  const plugins = Object.fromEntries(
    Object.keys(
      (
        JSON.parse(
          readFileSync(join(template, "appkit.plugins.json"), "utf-8"),
        ) as { plugins: Record<string, unknown> }
      ).plugins,
    ).map((name) => [name, {}]),
  );
  const files = globSync("**/*", {
    cwd: template,
    exclude: (name) => name === "node_modules",
  }).filter((file) => /\.(tsx?|sql|json|tmpl|ya?ml|html)$/.test(file));

  /** Renders the template like `apps init`: files that render empty are skipped. */
  function scaffold(vars: TemplateVars): Map<string, string> {
    const out = new Map<string, string>();
    for (const file of files) {
      const rendered = renderTemplateConditionals(
        readFileSync(join(template, file), "utf-8"),
        vars,
      );
      if (rendered.trim()) out.set(file, rendered);
    }
    return out;
  }

  const examples = [
    "config/queries/hello_world.sql",
    "config/queries/mocked_sales.sql",
    "server/example.test.ts",
  ];

  test("keeps the example queries and test by default", () => {
    const app = scaffold({ plugins });
    for (const file of examples) expect(app.has(file), file).toBe(true);
    expect(app.get("client/src/pages/analytics/AnalyticsPage.tsx")).toContain(
      "useAnalyticsQuery('hello_world'",
    );
  });

  test("leaves the example queries and test out with skipExamples", () => {
    const app = scaffold({ plugins, skipExamples: true });
    for (const file of examples) expect(app.has(file), file).toBe(false);
    for (const [file, content] of app) {
      expect(content, file).not.toMatch(/hello_world|mocked_sales/);
    }
    expect(app.get("client/src/pages/analytics/AnalyticsPage.tsx")).toContain(
      "export function AnalyticsPage()",
    );
  });

  test("renders no example queries without the analytics plugin", () => {
    const app = scaffold({ plugins: {} });
    expect(app.has("config/queries/hello_world.sql")).toBe(false);
    expect(app.has("config/queries/mocked_sales.sql")).toBe(false);
    expect(app.has("server/example.test.ts")).toBe(true);
  });

  test.each([false, true])(
    "leaves no template syntax in the gated files (skipExamples: %s)",
    (skipExamples) => {
      const app = scaffold({ plugins, skipExamples });
      for (const file of [
        ...examples,
        "client/src/pages/analytics/AnalyticsPage.tsx",
      ]) {
        expect(app.get(file) ?? "", file).not.toContain("{{");
      }
    },
  );
});
