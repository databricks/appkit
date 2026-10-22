import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

/**
 * Rule-firing fixtures for the template's oxlint config.
 *
 * Each fixture violates one rule and lands where that rule must apply: server `.ts` and client
 * `.tsx` are inside a tsconfig project (type-aware rules run), `.js` is covered by the JS-only
 * eslint:recommended rules, and `negative` fixtures pin rules that an override must switch off.
 * oxlint drops checks silently (category defaults, a tsconfig tsgolint rejects, a renamed
 * jsPlugin), so the smoke test asserts every fixture reports exactly its rules.
 */

export type FixtureKind = "server" | "client" | "js" | "config";

export interface LintFixture {
  /** Config key of the rule under test, e.g. `typescript/no-floating-promises`. */
  rule: string;
  kind: FixtureKind;
  code: string;
  /** Other rules the snippet unavoidably trips. */
  also?: string[];
  /** Rules that report only when an import resolves differently, e.g. npm hoisting vs pnpm. */
  maybe?: string[];
  /** Known oxlint engine gap: ESLint reports this snippet, oxlint does not. */
  gap?: string;
  /** The rule must NOT report here (an override turns it off for this kind). */
  negative?: boolean;
}

const directories: Record<FixtureKind, string> = {
  server: "server/lint-fixtures",
  client: "client/src/lint-fixtures",
  js: "server/lint-fixtures",
  config: "server/lint-fixtures",
};

const extensions: Record<FixtureKind, string> = {
  server: ".ts",
  client: ".tsx",
  js: ".js",
  config: ".config.ts",
};

/** Enabled rules that no source file can trigger, with the reason. */
export const UNREACHABLE_RULES: Record<string, string> = {
  "no-with":
    "`with` is a syntax error in ES modules, so the parser rejects it first",
  "no-delete-var": "deleting a variable is a syntax error in ES modules",
  "no-nonoctal-decimal-escape":
    "`\\8` and `\\9` escapes are syntax errors in ES modules",
  "react-hooks-js/component-hook-factories":
    "needs the compiler's validateNoDynamicallyCreatedComponentsOrHooks setting, off by default",
  "react-hooks-js/config":
    "reports invalid React Compiler plugin options, not source code",
  "react-hooks-js/gating":
    "reports invalid React Compiler gating options, not source code",
};

const js = (
  rule: string,
  code: string,
  extra: Partial<LintFixture> = {},
): LintFixture => ({
  rule,
  kind: "js",
  code,
  ...extra,
});
const server = (
  rule: string,
  code: string,
  extra: Partial<LintFixture> = {},
): LintFixture => ({
  rule,
  kind: "server",
  code,
  ...extra,
});
const client = (
  rule: string,
  code: string,
  extra: Partial<LintFixture> = {},
): LintFixture => ({
  rule,
  kind: "client",
  code,
  ...extra,
});

export const LINT_FIXTURES: LintFixture[] = [
  // eslint:recommended rules the TypeScript override turns off: they must report in JS only
  js(
    "constructor-super",
    "class B {}\nexport class A extends B {\n  constructor() {}\n}",
  ),
  js("getter-return", "export const o = {\n  get a() {},\n};"),
  js("no-class-assign", "class A {}\nA = 0;\nexport { A };"),
  js("no-const-assign", "const a = 0;\na = 1;\nexport { a };"),
  js("no-dupe-class-members", "export class A {\n  a() {}\n  a() {}\n}"),
  js("no-dupe-keys", "export const o = { a: 1, a: 2 };"),
  js("no-func-assign", "function f() {}\nf = 1;\nexport { f };"),
  js(
    "no-import-assign",
    'import * as fs from "node:fs";\nfs.readFileSync = null;',
  ),
  js("no-new-native-nonconstructor", 'export const s = new Symbol("a");'),
  js("no-obj-calls", "export const m = Math();"),
  js("no-redeclare", "var a = 1;\nvar a = 2;\nexport { a };", {
    gap: "oxlint skips no-redeclare in ES module .js files",
  }),
  js(
    "no-setter-return",
    "export const o = {\n  set a(v) {\n    return v;\n  },\n};",
  ),
  js(
    "no-this-before-super",
    "class B {}\nexport class A extends B {\n  constructor() {\n    this.a = 1;\n    super();\n  }\n}",
  ),
  js("no-undef", "export const a = missing;"),
  js("no-unreachable", "export function f() {\n  return 1;\n  f();\n}"),
  js("no-unsafe-negation", "export const f = (a, b) => !a in b;"),

  // The same snippets in TypeScript, where the compiler covers them instead
  server("no-dupe-keys", "export const o = { a: 1, a: 2 };", {
    negative: true,
  }),
  server("no-undef", "export const a: unknown = missing;", { negative: true }),
  server(
    "no-unreachable",
    "export function f(): number {\n  return 1;\n  f();\n}",
    {
      negative: true,
    },
  ),

  // eslint:recommended rules that apply everywhere
  server(
    "for-direction",
    "for (let i = 0; i < 10; i--) {\n  console.log(i);\n}",
  ),
  server(
    "no-async-promise-executor",
    "export const p = new Promise<number>(async (resolve) => {\n  resolve(await Promise.resolve(1));\n});",
    { also: ["typescript/no-misused-promises"] },
  ),
  server(
    "no-case-declarations",
    "export function f(x: number): number {\n  switch (x) {\n    case 1:\n      const a = 1;\n      return a;\n    default:\n      return 0;\n  }\n}",
  ),
  server("no-compare-neg-zero", "export const f = (x: number) => x === -0;"),
  server(
    "no-cond-assign",
    "export function f(x: number, y: number): void {\n  if (x = y) console.log(x);\n}",
  ),
  server(
    "no-constant-binary-expression",
    "export const f = (x: number) => !x == null;",
  ),
  server("no-constant-condition", 'if (1) console.log("a");'),
  server("no-control-regex", "export const r = /\\x1f/;"),
  server("no-debugger", "debugger;"),
  server(
    "no-dupe-else-if",
    'export function f(x: number): void {\n  if (x === 1) console.log("a");\n  else if (x === 1) console.log("b");\n}',
  ),
  server(
    "no-duplicate-case",
    'export function f(x: number): void {\n  switch (x) {\n    case 1:\n      console.log("a");\n      break;\n    case 1:\n      console.log("b");\n      break;\n  }\n}',
  ),
  server(
    "no-empty",
    "export function f(x: boolean): void {\n  if (x) {\n  }\n}",
  ),
  server("no-empty-character-class", "export const r = /a[]/;"),
  server("no-empty-pattern", "export function f({}: object): void {}"),
  server("no-empty-static-block", "export class A {\n  static {}\n}"),
  server(
    "no-ex-assign",
    "export function f(): void {\n  try {\n    console.log();\n  } catch (e) {\n    e = 1;\n    console.log(e);\n  }\n}",
  ),
  server(
    "no-extra-boolean-cast",
    "export const f = (x: number) => (!!x ? 1 : 0);",
  ),
  server(
    "no-fallthrough",
    'export function f(x: number): void {\n  switch (x) {\n    case 1:\n      console.log("a");\n    case 2:\n      console.log("b");\n  }\n}',
  ),
  server("no-global-assign", "Object = null;"),
  server("no-invalid-regexp", 'export const r = new RegExp("[");'),
  server("no-irregular-whitespace", "export const a = 1;\u000b"),
  server("no-loss-of-precision", "export const a = 9007199254740993;"),
  server("no-misleading-character-class", "export const r = /[👍]/;"),
  server(
    "no-prototype-builtins",
    'export const f = (o: object) => o.hasOwnProperty("a");',
  ),
  server("no-regex-spaces", "export const r = /a   b/;"),
  server(
    "no-self-assign",
    "export function f(x: number): void {\n  x = x;\n  console.log(x);\n}",
  ),
  server(
    "no-shadow-restricted-names",
    "export function f(NaN: number): number {\n  return NaN;\n}",
  ),
  server("no-sparse-arrays", "export const a = [1, , 2];"),
  server(
    "no-unsafe-finally",
    "export function f(): number {\n  try {\n    return 1;\n  } finally {\n    return 2;\n  }\n}",
  ),
  server(
    "no-unsafe-optional-chaining",
    "export const f = (o?: { g: () => number }) => (o?.g)();",
  ),
  server(
    "no-unused-labels",
    "export function f(): void {\n  label: console.log();\n}",
  ),
  server(
    "no-unused-private-class-members",
    "export class A {\n  #unused = 1;\n}",
  ),
  server("no-useless-backreference", "export const r = /(a)|\\1/;"),
  server(
    "no-useless-catch",
    "export function f(): void {\n  try {\n    console.log();\n  } catch (e) {\n    throw e;\n  }\n}",
  ),
  server("no-useless-escape", 'export const s = "\\a";'),
  server(
    "require-yield",
    "export function* g(): Generator<number> {\n  return 1;\n}",
  ),
  server("use-isnan", "export const f = (x: number) => x === NaN;"),
  server(
    "valid-typeof",
    'export const f = (x: unknown) => typeof x === "strnig";',
  ),

  // typescript-eslint recommended-type-checked
  server("no-array-constructor", "export const a = new Array(1, 2);"),
  server(
    "no-unused-expressions",
    "export function f(x: number): void {\n  x + 1;\n}",
  ),
  server("no-unused-vars", "const unused = 1;"),
  server(
    "typescript/await-thenable",
    "export async function f(): Promise<number> {\n  return await 1;\n}",
  ),
  server(
    "typescript/ban-ts-comment",
    "// @ts-ignore\nexport const a: number = 1;",
  ),
  server(
    "typescript/no-array-delete",
    "export function f(a: number[]): void {\n  delete a[0];\n}",
  ),
  server("typescript/no-base-to-string", "export const s = String({});"),
  server(
    "typescript/no-duplicate-enum-values",
    "export enum E {\n  A = 1,\n  B = 1,\n}",
  ),
  server(
    "typescript/no-duplicate-type-constituents",
    "export type T = string | string;",
  ),
  server("typescript/no-empty-object-type", "export interface I {}"),
  server("typescript/no-explicit-any", "export const a: any = 1;"),
  server(
    "typescript/no-extra-non-null-assertion",
    "export const f = (x?: number) => x!!;",
    { also: ["typescript/no-unnecessary-type-assertion"] },
  ),
  server(
    "typescript/no-floating-promises",
    "export function f(): void {\n  Promise.resolve(1);\n}",
  ),
  server(
    "typescript/no-for-in-array",
    "export function f(a: number[]): void {\n  for (const i in a) console.log(i);\n}",
  ),
  server("typescript/no-implied-eval", 'setTimeout("console.log(1)");'),
  server("typescript/no-misused-new", "export interface I {\n  new (): I;\n}"),
  server(
    "typescript/no-misused-promises",
    'export function f(p: Promise<number>): void {\n  if (p) console.log("a");\n}',
  ),
  server(
    "typescript/no-namespace",
    "export namespace N {\n  export const a = 1;\n}",
  ),
  server(
    "typescript/no-non-null-asserted-optional-chain",
    "export const f = (o?: { a: number }) => o?.a!;",
  ),
  server(
    "typescript/no-redundant-type-constituents",
    "export type T = string | unknown;",
  ),
  server(
    "typescript/no-require-imports",
    'const fs = require("node:fs");\nexport { fs };',
    {
      also: ["typescript/no-unsafe-assignment"],
    },
  ),
  server(
    "typescript/no-this-alias",
    "export class A {\n  f(): A {\n    const self = this;\n    return self;\n  }\n}",
  ),
  server(
    "typescript/no-unnecessary-type-assertion",
    "export const f = (s: string) => s as string;",
  ),
  server(
    "typescript/no-unnecessary-type-constraint",
    "export const f = <T extends unknown>(x: T) => x;",
  ),
  server(
    "typescript/no-unsafe-argument",
    'export function f(): void {\n  console.log(...JSON.parse("[]"));\n}',
  ),
  server(
    "typescript/no-unsafe-assignment",
    'export const a: number = JSON.parse("1");',
  ),
  server(
    "typescript/no-unsafe-call",
    'export function f(): void {\n  JSON.parse("1")();\n}',
  ),
  server(
    "typescript/no-unsafe-declaration-merging",
    "export interface A {\n  a: number;\n}\nexport class A {}",
  ),
  server(
    "typescript/no-unsafe-enum-comparison",
    "enum E {\n  A = 1,\n}\nexport const f = (e: E) => e === 1;",
  ),
  server("typescript/no-unsafe-function-type", "export type F = Function;"),
  server(
    "typescript/no-unsafe-member-access",
    'export const a: unknown = JSON.parse("{}").a;',
  ),
  server(
    "typescript/no-unsafe-return",
    'export function f(): number {\n  return JSON.parse("1");\n}',
  ),
  server(
    "typescript/no-unsafe-unary-minus",
    "export const f = (s: string) => -(s as unknown as bigint | string);",
  ),
  server("typescript/no-wrapper-object-types", "export type S = String;"),
  server(
    "typescript/only-throw-error",
    'export function f(): void {\n  throw "x";\n}',
  ),
  server("typescript/prefer-as-const", 'export const o = { a: "a" as "a" };'),
  server(
    "typescript/prefer-namespace-keyword",
    "export declare module M {\n  export const a: number;\n}",
    {
      also: ["typescript/no-namespace"],
    },
  ),
  server(
    "typescript/prefer-promise-reject-errors",
    'export const p = Promise.reject("x");',
  ),
  server(
    "typescript/require-await",
    "export async function f(): Promise<number> {\n  return 1;\n}",
  ),
  server(
    "typescript/restrict-plus-operands",
    "export function f(a: number, b: bigint): void {\n  console.log(a + b);\n}",
  ),
  server(
    "typescript/restrict-template-expressions",
    "export const f = (o: object) => `${o}`;",
    {
      also: ["typescript/no-base-to-string"],
    },
  ),
  server(
    "typescript/triple-slash-reference",
    '/// <reference path="./other.ts" />\nexport {};',
  ),
  server(
    "typescript/unbound-method",
    "class A {\n  m(): void {}\n}\nexport const f = new A().m;",
  ),

  // TypeScript-only additions
  server("no-var", "export var a = 1;"),
  server("prefer-const", "let a = 1;\nexport { a };"),
  server(
    "prefer-rest-params",
    "export function f(): IArguments {\n  return arguments;\n}",
  ),
  server(
    "prefer-spread",
    "export const f = (g: (...a: number[]) => void, a: number[]) => g.apply(null, a);",
  ),

  // Type-aware rules stay off where no tsconfig project covers the file
  {
    rule: "typescript/no-floating-promises",
    kind: "config",
    code: "export function f(): void {\n  Promise.resolve(1);\n}",
    negative: true,
  },
  js(
    "typescript/no-floating-promises",
    "export function f() {\n  Promise.resolve(1);\n}",
    {
      negative: true,
    },
  ),

  // React rules apply to client code only
  server(
    "react/rules-of-hooks",
    'import { useState } from "react";\nexport function useX(x: boolean): void {\n  if (x) useState(0);\n}',
    { negative: true },
  ),

  // eslint-plugin-react recommended
  client(
    "react/display-name",
    'import { memo } from "react";\nexport default memo(() => <div />);',
    {
      gap: "oxlint misses anonymous memo/forwardRef default exports",
      also: ["react/only-export-components"],
    },
  ),
  client(
    "react/jsx-key",
    "export const C = ({ a }: { a: number[] }) => <ul>{a.map((x) => <li>{x}</li>)}</ul>;",
  ),
  client(
    "react/jsx-no-comment-textnodes",
    "export const C = () => <div>// comment</div>;",
  ),
  client(
    "react/jsx-no-duplicate-props",
    'export const C = () => <div id="a" id="b" />;',
  ),
  client(
    "react/jsx-no-target-blank",
    'export const C = () => <a href="https://example.com" target="_blank">x</a>;',
  ),
  client("react/jsx-no-undef", "export const C = () => <Missing />;"),
  client(
    "react/no-children-prop",
    'export const C = () => <div children="x" />;',
  ),
  client(
    "react/no-danger-with-children",
    'export const C = () => <div dangerouslySetInnerHTML={{ __html: "x" }}>y</div>;',
  ),
  client(
    "react/no-direct-mutation-state",
    'import { Component } from "react";\nexport class C extends Component<object, { a: number }> {\n  f(): void {\n    this.state.a = 1;\n  }\n  render() {\n    return null;\n  }\n}',
  ),
  client(
    "react/no-find-dom-node",
    'import { Component } from "react";\nimport { findDOMNode } from "react-dom";\nexport class C extends Component {\n  componentDidMount(): void {\n    findDOMNode(this);\n  }\n  render() {\n    return null;\n  }\n}',
    { also: ["typescript/no-unsafe-call"] },
  ),
  client(
    "react/no-is-mounted",
    'import { Component } from "react";\nexport class C extends Component {\n  f(): boolean {\n    return this.isMounted();\n  }\n  render() {\n    return null;\n  }\n}',
    { also: ["typescript/no-unsafe-call", "typescript/no-unsafe-return"] },
  ),
  client(
    "react/no-render-return-value",
    'import ReactDOM from "react-dom";\nexport const r: unknown = ReactDOM.render(<div />, document.body);',
    { also: ["typescript/no-unsafe-call"] },
  ),
  client("react/no-string-refs", 'export const C = () => <div ref="a" />;'),
  client(
    "react/no-unescaped-entities",
    "export const C = () => <div>don't</div>;",
  ),
  client(
    "react/no-unknown-property",
    'export const C = () => <div class="a" />;',
  ),
  client(
    "react/require-render-return",
    'import { Component } from "react";\nexport class C extends Component {\n  render() {\n    <div />;\n  }\n}',
  ),
  client(
    "react/no-unsafe",
    'import { Component } from "react";\nexport class C extends Component {\n  componentWillMount(): void {}\n  render() {\n    return null;\n  }\n}',
  ),
  // tsgolint skips a whole project whose tsconfig it rejects (e.g. one with baseUrl)
  client(
    "typescript/no-floating-promises",
    "export function f(): void {\n  Promise.resolve(1);\n}",
  ),
  client(
    "typescript/no-deprecated",
    'export function copy(): void {\n  document.execCommand("copy");\n}',
  ),

  // eslint-plugin-react-hooks recommended
  client(
    "react/rules-of-hooks",
    'import { useState } from "react";\nexport function C({ x }: { x: boolean }) {\n  if (x) useState(0);\n  return null;\n}',
  ),
  client(
    "react/exhaustive-deps",
    'import { useEffect } from "react";\nexport function C({ a }: { a: number }) {\n  useEffect(() => {\n    console.log(a);\n  }, []);\n  return null;\n}',
  ),
  client(
    "react-hooks-js/error-boundaries",
    "export function C() {\n  try {\n    return <div />;\n  } catch {\n    return null;\n  }\n}",
  ),
  client(
    "react-hooks-js/globals",
    "let count = 0;\nexport function C() {\n  count = count + 1;\n  return <div>{count}</div>;\n}",
  ),
  client(
    "react-hooks-js/immutability",
    "export function C({ o }: { o: { a: number } }) {\n  o.a = 1;\n  return <div />;\n}",
  ),
  client(
    "react-hooks-js/incompatible-library",
    'import { useReactTable } from "@tanstack/react-table";\nexport function C() {\n  const table = useReactTable({});\n  return <div>{table}</div>;\n}',
    {
      // Unresolved (and so `any`) under pnpm, hoisted from appkit-ui under npm
      maybe: ["typescript/no-unsafe-assignment", "typescript/no-unsafe-call"],
    },
  ),
  client(
    "react-hooks-js/preserve-manual-memoization",
    'import { useMemo } from "react";\nexport function C({ a }: { a: number[] }) {\n  const v = useMemo(() => a.map((x) => x * 2), [a.length]);\n  return <div>{v.length}</div>;\n}',
    { also: ["react/exhaustive-deps"] },
  ),
  client(
    "react-hooks-js/purity",
    "export function C() {\n  return <div>{Date.now()}</div>;\n}",
  ),
  client(
    "react-hooks-js/refs",
    'import { useRef } from "react";\nexport function C() {\n  const r = useRef(0);\n  return <div>{r.current}</div>;\n}',
  ),
  client(
    "react-hooks-js/set-state-in-effect",
    'import { useEffect, useState } from "react";\nexport function C() {\n  const [a, setA] = useState(0);\n  useEffect(() => {\n    setA(1);\n  }, []);\n  return <div>{a}</div>;\n}',
  ),
  client(
    "react-hooks-js/set-state-in-render",
    'import { useState } from "react";\nexport function C() {\n  const [a, setA] = useState(0);\n  setA(1);\n  return <div>{a}</div>;\n}',
  ),
  client(
    "react-hooks-js/static-components",
    "export function C() {\n  const Inner = () => <div />;\n  return <Inner />;\n}",
  ),
  client(
    "react-hooks-js/unsupported-syntax",
    'export function C() {\n  eval("1");\n  return <div />;\n}',
  ),
  client(
    "react-hooks-js/use-memo",
    'import { useMemo } from "react";\nexport function C() {\n  useMemo((x: number) => x, []);\n  return <div />;\n}',
  ),

  // eslint-plugin-react-refresh
  client(
    "react/only-export-components",
    "export const a = {};\nexport const C = () => <div />;",
  ),

  // Additional template rules
  client(
    "react/no-array-index-key",
    "export const C = ({ a }: { a: number[] }) => <ul>{a.map((x, i) => <li key={i}>{x}</li>)}</ul>;",
  ),
];

/** Config key for an oxlint diagnostic code, e.g. `eslint(no-debugger)` → `no-debugger`. */
export function ruleOf(code: string): string {
  const match = /^([\w-]+)\((.+)\)$/.exec(code);
  if (!match) return code;
  const [, plugin, rule] = match;
  if (plugin === "eslint") return rule;
  // oxlint's native hooks rules are configured as react/* but report as react-hooks(*)
  return `${plugin === "react-hooks" ? "react" : plugin}/${rule}`;
}

type RuleSetting = string | number | [string | number, ...unknown[]];
interface OxlintConfig {
  categories?: Record<string, string>;
  rules?: Record<string, RuleSetting>;
  overrides?: { files: string[]; rules?: Record<string, RuleSetting> }[];
}

export function readOxlintConfig(path: string): OxlintConfig {
  const { config, error } = ts.parseConfigFileTextToJson(
    path,
    readFileSync(path, "utf-8"),
  );
  if (error)
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  return config as OxlintConfig;
}

/** Every rule the config enables at top level or in any override. */
export function enabledRules(config: OxlintConfig): Set<string> {
  const enabled = new Set<string>();
  for (const rules of [
    config.rules,
    ...(config.overrides ?? []).map((o) => o.rules),
  ]) {
    for (const [rule, setting] of Object.entries(rules ?? {})) {
      const level = Array.isArray(setting) ? setting[0] : setting;
      if (level !== "off" && level !== 0) enabled.add(rule);
    }
  }
  return enabled;
}

export function fixturePath(fixture: LintFixture, index: number): string {
  const name = `${String(index).padStart(3, "0")}-${fixture.rule.replace(/\//g, "__")}`;
  return `${directories[fixture.kind]}/${name}${extensions[fixture.kind]}`;
}

export interface Diagnostic {
  code: string;
  filename: string;
}

/** Problems with the reported rules, empty when every fixture reports exactly what it declares. */
export function compareLintResults(
  fixtures: LintFixture[],
  diagnostics: Diagnostic[],
): string[] {
  const reported = new Map<string, Set<string>>();
  for (const { code, filename } of diagnostics) {
    const rules = reported.get(filename) ?? new Set<string>();
    rules.add(ruleOf(code));
    reported.set(filename, rules);
  }
  const problems: string[] = [];
  const files = new Set<string>();
  fixtures.forEach((fixture, index) => {
    const file = fixturePath(fixture, index);
    files.add(file);
    const actual = reported.get(file) ?? new Set<string>();
    const expected = new Set(fixture.also ?? []);
    if (!fixture.negative && !fixture.gap) expected.add(fixture.rule);
    if (fixture.gap && actual.has(fixture.rule)) {
      problems.push(
        `${file}: ${fixture.rule} now reports; the gap closed, drop \`gap\``,
      );
      actual.delete(fixture.rule);
    }
    const missing = [...expected].filter((rule) => !actual.has(rule));
    const unexpected = [...actual].filter(
      (rule) => !expected.has(rule) && !fixture.maybe?.includes(rule),
    );
    if (missing.length)
      problems.push(`${file}: expected ${missing.join(", ")}`);
    if (unexpected.length)
      problems.push(`${file}: unexpected ${unexpected.join(", ")}`);
  });
  for (const file of reported.keys()) {
    if (!files.has(file))
      problems.push(`${file}: diagnostics outside the fixtures`);
  }
  return problems;
}

/**
 * Writes the fixtures into an installed app, lints them with the app's own oxlint, and throws
 * unless every fixture reports exactly its declared rules. Removes the fixtures afterwards.
 */
export function checkTemplateLint(
  app: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const appDir = resolve(app);
  // oxlint honours .gitignore files up to the repository root; make the app its own root so a
  // scaffold inside a gitignored directory (like .smoke-test/) is still linted.
  execFileSync("git", ["init", "--quiet"], { cwd: appDir, env });
  const roots = [...new Set(Object.values(directories))];
  try {
    LINT_FIXTURES.forEach((fixture, index) => {
      const path = join(appDir, fixturePath(fixture, index));
      mkdirSync(dirname(path), { recursive: true });
      const module = /^\s*export\b/m.test(fixture.code) ? "" : "\nexport {};";
      writeFileSync(path, `${fixture.code}${module}\n`);
    });
    // Exit status 1 only means the fixtures reported errors, which they are meant to.
    const result = spawnSync(
      join(appDir, "node_modules/.bin/oxlint"),
      ["--format", "json", ...roots],
      { cwd: appDir, env, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`oxlint exited with ${result.status}:\n${result.stderr}`);
    }
    let diagnostics: Diagnostic[];
    try {
      ({ diagnostics } = JSON.parse(result.stdout) as {
        diagnostics: Diagnostic[];
      });
    } catch {
      throw new Error(
        `oxlint did not report JSON:\n${result.stdout}\n${result.stderr}`,
      );
    }
    const problems = compareLintResults(LINT_FIXTURES, diagnostics);
    if (problems.length) {
      throw new Error(
        `Template oxlint config drifted:\n  ${problems.join("\n  ")}`,
      );
    }
    console.log(
      `oxlint: ${LINT_FIXTURES.length} rule fixtures reported as declared`,
    );
  } finally {
    for (const root of roots)
      rmSync(join(appDir, root), { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const appDir = process.argv[2];
  if (!appDir)
    throw new Error("Usage: tsx tools/template-lint-fixtures.ts <app-dir>");
  checkTemplateLint(appDir);
}
