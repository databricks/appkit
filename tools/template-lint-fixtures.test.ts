import { existsSync, globSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, test } from "vitest";

import {
  compareLintResults,
  enabledRules,
  fixturePath,
  LINT_FIXTURES,
  type LintFixture,
  readOxlintConfig,
  ruleOf,
  UNREACHABLE_RULES,
} from "./template-lint-fixtures";

const root = resolve(import.meta.dirname, "..");
const template = join(root, "template");
const config = readOxlintConfig(join(template, ".oxlintrc.json"));
const readJson = (path: string) =>
  JSON.parse(readFileSync(join(root, path), "utf-8"));

describe("fixture coverage", () => {
  const enabled = enabledRules(config);
  const covered = new Set(
    LINT_FIXTURES.filter((f) => !f.negative).map((f) => f.rule),
  );

  test("every enabled rule has a fixture or a documented reason it has none", () => {
    const uncovered = [...enabled].filter(
      (rule) => !covered.has(rule) && !(rule in UNREACHABLE_RULES),
    );
    expect(uncovered).toEqual([]);
  });

  test("fixtures and exemptions only name enabled rules", () => {
    const named = [
      ...LINT_FIXTURES.flatMap((f) => [
        f.rule,
        ...(f.also ?? []),
        ...(f.maybe ?? []),
      ]),
      ...Object.keys(UNREACHABLE_RULES),
    ];
    expect([...new Set(named)].filter((rule) => !enabled.has(rule))).toEqual(
      [],
    );
  });

  test("unreachable rules have no positive fixture", () => {
    expect(
      Object.keys(UNREACHABLE_RULES).filter((rule) => covered.has(rule)),
    ).toEqual([]);
  });

  test("fixture paths are unique", () => {
    const paths = LINT_FIXTURES.map(fixturePath);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("ruleOf", () => {
  test.each([
    ["eslint(no-debugger)", "no-debugger"],
    ["typescript(no-floating-promises)", "typescript/no-floating-promises"],
    ["react(jsx-key)", "react/jsx-key"],
    ["react-hooks(rules-of-hooks)", "react/rules-of-hooks"],
    ["react-hooks-js(purity)", "react-hooks-js/purity"],
    ["", ""],
  ])("%j → %j", (code, rule) => {
    expect(ruleOf(code)).toBe(rule);
  });
});

describe("compareLintResults", () => {
  const fixtures: LintFixture[] = [
    { rule: "no-debugger", kind: "server", code: "debugger;" },
    { rule: "no-undef", kind: "server", code: "missing;", negative: true },
    {
      rule: "no-redeclare",
      kind: "js",
      code: "var a; var a;",
      gap: "engine gap",
    },
    {
      rule: "typescript/no-unsafe-call",
      kind: "client",
      code: "",
      also: ["typescript/no-unsafe-return"],
    },
  ];
  const [debuggerFile, undefFile, redeclareFile, unsafeFile] =
    fixtures.map(fixturePath);
  const passing = [
    { code: "eslint(no-debugger)", filename: debuggerFile },
    { code: "typescript(no-unsafe-call)", filename: unsafeFile },
    { code: "typescript(no-unsafe-return)", filename: unsafeFile },
  ];

  test("passes when every fixture reports exactly its rules", () => {
    expect(compareLintResults(fixtures, passing)).toEqual([]);
  });

  test("flags a rule that stopped reporting", () => {
    expect(compareLintResults(fixtures, passing.slice(1))).toEqual([
      `${debuggerFile}: expected no-debugger`,
    ]);
  });

  test("flags a rule that reports where an override turns it off", () => {
    expect(
      compareLintResults(fixtures, [
        ...passing,
        { code: "eslint(no-undef)", filename: undefFile },
      ]),
    ).toEqual([`${undefFile}: unexpected no-undef`]);
  });

  test("flags a closed engine gap", () => {
    expect(
      compareLintResults(fixtures, [
        ...passing,
        { code: "eslint(no-redeclare)", filename: redeclareFile },
      ]),
    ).toEqual([
      `${redeclareFile}: no-redeclare now reports; the gap closed, drop \`gap\``,
    ]);
  });

  test("flags a missing companion rule", () => {
    expect(compareLintResults(fixtures, passing.slice(0, 2))).toEqual([
      `${unsafeFile}: expected typescript/no-unsafe-return`,
    ]);
  });

  test("tolerates resolution-dependent rules either way", () => {
    const maybe: LintFixture[] = [
      {
        rule: "no-debugger",
        kind: "server",
        code: "",
        maybe: ["typescript/no-unsafe-call"],
      },
    ];
    const file = fixturePath(maybe[0], 0);
    const hit = { code: "eslint(no-debugger)", filename: file };
    expect(compareLintResults(maybe, [hit])).toEqual([]);
    expect(
      compareLintResults(maybe, [
        hit,
        { code: "typescript(no-unsafe-call)", filename: file },
      ]),
    ).toEqual([]);
  });

  test("flags diagnostics outside the fixtures", () => {
    expect(
      compareLintResults(fixtures, [
        ...passing,
        { code: "eslint(no-debugger)", filename: "server/server.ts" },
      ]),
    ).toEqual(["server/server.ts: diagnostics outside the fixtures"]);
  });
});

describe("template lint setup", () => {
  test("enables rules explicitly instead of through categories", () => {
    // A category default would silently decide which rules run; the list in the config is the contract.
    expect(
      Object.values(config.categories ?? {}).filter((level) => level !== "off"),
    ).toEqual([]);
  });

  test("loads the React Compiler rules under a non-reserved plugin name", () => {
    const plugins =
      (config as { jsPlugins?: (string | { name: string })[] }).jsPlugins ?? [];
    const names = plugins.map((plugin) =>
      typeof plugin === "string" ? plugin : plugin.name,
    );
    // oxlint reserves `react-hooks` for its native rules
    expect(names).toEqual(["react-hooks-js"]);
  });

  test("no template tsconfig sets baseUrl, which makes tsgolint skip type-aware rules", () => {
    for (const file of globSync("tsconfig*.json", { cwd: template })) {
      const path = join(template, file);
      const { config: tsconfig } = ts.readConfigFile(path, ts.sys.readFile);
      expect(tsconfig.compilerOptions?.baseUrl, file).toBeUndefined();
    }
  });

  test("root oxlint invocations ignore the template's nested config", () => {
    const pkg = readJson("package.json");
    const commands = [
      ...["lint", "lint:fix", "check", "check:fix"].map(
        (name) => pkg.scripts[name] as string,
      ),
      ...(pkg["lint-staged"]["*.{ts,tsx,js,jsx}"] as string[]),
    ];
    for (const command of commands.filter((c) => c.includes("oxlint"))) {
      expect(command).toMatch(/oxlint --disable-nested-config/);
    }
  });

  test("the template lints with oxlint and carries no ESLint config", () => {
    const pkg = readJson("template/package.json");
    expect(pkg.scripts.lint).toBe("oxlint");
    expect(pkg.scripts["lint:fix"]).toBe("oxlint --fix");
    expect(globSync("eslint.config.*", { cwd: template })).toEqual([]);
    expect(existsSync(join(template, ".eslintrc.json"))).toBe(false);
    const eslintPackages = Object.keys(pkg.devDependencies).filter((name) =>
      /eslint/.test(name),
    );
    // eslint-plugin-react-hooks backs the react-hooks-js rules and needs eslint as a peer
    expect(eslintPackages.sort()).toEqual([
      "eslint",
      "eslint-plugin-react-hooks",
    ]);
  });

  test("suppressions of React Compiler rules use the aliased plugin name", () => {
    const compilerRules = [...enabledRules(config)]
      .filter((rule) => rule.startsWith("react-hooks-js/"))
      .map((rule) => rule.slice("react-hooks-js/".length));
    const stale = new RegExp(
      `(?:eslint|oxlint)-disable.*\\breact-hooks/(?:${compilerRules.join("|")})\\b`,
    );
    const offenders = globSync("{client,server,shared}/**/*.{ts,tsx,js,jsx}", {
      cwd: template,
    }).filter((file) =>
      stale.test(readFileSync(join(template, file), "utf-8")),
    );
    expect(offenders).toEqual([]);
  });
});
