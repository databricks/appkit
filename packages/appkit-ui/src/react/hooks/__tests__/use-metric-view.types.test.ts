import path from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

const packageRoot =
  path.basename(process.cwd()) === "appkit-ui"
    ? process.cwd()
    : path.join(process.cwd(), "packages", "appkit-ui");

function compileTypeProbe(source: string): readonly ts.Diagnostic[] {
  const configPath = path.join(packageRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    packageRoot,
  );
  parsed.options.types = [...(parsed.options.types ?? []), "vite/client"];
  const filename = path.join(packageRoot, "__type-tests__", "metric-view.ts");
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (candidate) =>
    candidate === filename || ts.sys.fileExists(candidate);
  host.readFile = (candidate) =>
    candidate === filename ? source : ts.sys.readFile(candidate);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreate) =>
    candidate === filename
      ? ts.createSourceFile(
          candidate,
          source,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        )
      : getSourceFile(candidate, languageVersion, onError, shouldCreate);

  const program = ts.createProgram([filename], parsed.options, host);
  return ts.getPreEmitDiagnostics(program);
}

test("useMetricView keeps omitted dimensions out of rows and requires a grain target", () => {
  const diagnostics = compileTypeProbe(`
    import { useMetricView } from "../src/react/hooks/use-metric-view";
    import type { MetricOrderBy } from "../src/react";
    import type { UseMetricViewOptions, UseMetricViewResult } from "../src/react/hooks/types";

    declare module "../src/react/hooks/types" {
      interface MetricRegistry {
        revenue: {
          measures: { arr: string | null; mrr: string | null };
          dimensions: { region: string | null; created_at: string | null };
          measureKeys: "arr" | "mrr";
          dimensionKeys: "region" | "created_at";
          timeGrains: "day" | "month";
          metadata: {
            measures: {};
            dimensions: {
              region: { type: "string" };
              created_at: {
                type: "timestamp";
                time_grain: readonly ["day", "month"];
              };
            };
          };
        };
      }
    }

    type MeasureOnlyResult = ReturnType<
      typeof useMetricView<"revenue", readonly ["arr"]>
    >;
    declare const result: MeasureOnlyResult;
    const expected: UseMetricViewResult<Array<{ arr: string | null }>> = result;
    void expected;
    // @ts-expect-error region was not selected
    result.data?.[0]?.region;

    type TimeOptions = UseMetricViewOptions<
      "revenue",
      readonly ["arr"],
      readonly ["created_at"]
    >;
    const valid: TimeOptions = {
      measures: ["arr"],
      dimensions: ["created_at"],
      timeDimension: "created_at",
      timeGrain: "month",
    };
    void valid;

    const reusableOrderBy: ReadonlyArray<MetricOrderBy<"arr" | "created_at">> = [
      { field: "arr", direction: "DESC" },
      { field: "created_at" },
    ];
    const ordered: TimeOptions = {
      measures: ["arr"],
      dimensions: ["created_at"],
      orderBy: reusableOrderBy,
    };
    void ordered;

    const unselectedOrderBy: ReadonlyArray<MetricOrderBy<"mrr">> = [{ field: "mrr" }];
    // @ts-expect-error mrr was not selected
    const invalidOrder: TimeOptions = { measures: ["arr"], dimensions: ["created_at"], orderBy: unselectedOrderBy };
    void invalidOrder;

    const broadOrderBy: MetricOrderBy[] = [{ field: "arr", direction: "DESC" }];
    // @ts-expect-error MetricOrderBy<string> does not prove that its fields were selected
    const broadOrder: TimeOptions = { measures: ["arr"], dimensions: ["created_at"], orderBy: broadOrderBy };
    void broadOrder;

    // @ts-expect-error timeGrain requires timeDimension
    const missingTarget: TimeOptions = { measures: ["arr"], dimensions: ["created_at"], timeGrain: "month" };
    void missingTarget;

    type NoDimensionOptions = UseMetricViewOptions<
      "revenue",
      readonly ["arr"],
      readonly []
    >;
    // @ts-expect-error timeDimension must be selected in dimensions
    const unselectedTarget: NoDimensionOptions = { measures: ["arr"], timeDimension: "created_at", timeGrain: "month" };
    void unselectedTarget;
  `);

  expect(
    diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ),
  ).toEqual([]);
});
