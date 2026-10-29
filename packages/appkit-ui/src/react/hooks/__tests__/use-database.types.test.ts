import path from "node:path";

import ts from "typescript";
import { expect, test, vi } from "vitest";

const packageRoot =
  path.basename(process.cwd()) === "appkit-ui"
    ? process.cwd()
    : path.join(process.cwd(), "packages", "appkit-ui");

// Each probe type-checks the package with the TypeScript compiler, which can
// exceed Vitest's 5s default on CI's 2-core runners.
vi.setConfig({ testTimeout: 30_000 });

const PROBE = path.join(packageRoot, "__type-tests__", "database.ts");

/**
 * Compile `source` as the only consumer in its own program, so a fixture's
 * global augmentation never reaches another probe or the package itself.
 * Returns every diagnostic as `line TScode message`.
 */
function compileTypeProbe(source: string): string[] {
  const config = ts.readConfigFile(
    path.join(packageRoot, "tsconfig.json"),
    ts.sys.readFile,
  );
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    packageRoot,
  );
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (file) => file === PROBE || ts.sys.fileExists(file);
  host.readFile = (file) => (file === PROBE ? source : ts.sys.readFile(file));
  host.getSourceFile = (file, language, onError, shouldCreate) =>
    file === PROBE
      ? ts.createSourceFile(file, source, language, true, ts.ScriptKind.TS)
      : getSourceFile(file, language, onError, shouldCreate);

  const program = ts.createProgram([PROBE], parsed.options, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const where =
      diagnostic.file?.fileName === PROBE
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
            .line + 1
        : (diagnostic.file?.fileName ?? "global");
    return `${where} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  });
}

const DIRECTIVE = /\/\/ @ts-expect-error (TS\d+) /g;

/** The `line TScode` each directive promises for the line after it. */
function expectedProbes(source: string): string[] {
  return source.split("\n").flatMap((text, index) => {
    const match = /\/\/ @ts-expect-error (TS\d+) /.exec(text);
    return match ? [`${index + 2} ${match[1]}`] : [];
  });
}

/**
 * Each probe must fail for the reason its directive names: with the
 * directives disabled, every probe line reports exactly its own code.
 */
function expectEachProbeRejected(source: string): void {
  expect(compileTypeProbe(source)).toEqual([]);
  const raw = compileTypeProbe(source.replace(DIRECTIVE, "// probe $1 "));
  expect(
    raw
      .map((finding) => finding.split(" ").slice(0, 2).join(" "))
      .sort((a, b) => Number(a.split(" ")[0]) - Number(b.split(" ")[0])),
  ).toEqual(expectedProbes(source));
}

// Entries as generation renders them into the global registry.
const GENERATED = `
  declare global {
    interface DatabricksAppKitDatabaseOperations {
      "notes.get": {
        method: "GET";
        input: { id: number };
        output: { id: number; body: string; total: string };
      };
      "notes.search": {
        method: "GET";
        input: { board_id: number; text?: string };
        output: { id: number; body: string }[];
      };
      "notes.find": {
        method: "GET";
        input: { id: number };
        output: { id: number; body: string } | null;
      };
      "notes.create": {
        method: "POST";
        input: { board_id: number; body: string; total?: string | number };
        output: { id: number; body: string; total: string };
      };
      "notes.update": {
        method: "PATCH";
        input: { id: number; changes: { body?: string } };
        output: { id: number; body: string; total: string };
      };
      "notes.replace": {
        method: "PUT";
        input: { id: number; values: { body: string } };
        output: { id: number; body: string; total: string };
      };
      "notes.delete": {
        method: "DELETE";
        input: { id: number };
        output: void;
      };
    }
  }
`;

const IMPORTS = `
  import { databaseApi } from "@databricks/appkit-ui/js/beta";
  import {
    type DatabaseApiError,
    type DatabaseMutationName,
    type DatabaseMutationOutcome,
    type DatabaseOperationInput,
    type DatabaseOperationName,
    type DatabaseOperationOutput,
    type DatabaseQueryName,
    useDatabaseMutation,
    useDatabaseQuery,
  } from "@databricks/appkit-ui/react/beta";
`;

test("names, inputs, and answers come from the generated operations", () => {
  const diagnostics = compileTypeProbe(`
    ${IMPORTS}
    ${GENERATED}

    type Equal<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    type Expect<T extends true> = T;
    type Note = { id: number; body: string; total: string };

    export type Names = [
      Expect<Equal<DatabaseOperationName, "notes.get" | "notes.search" | "notes.find" | "notes.create" | "notes.update" | "notes.replace" | "notes.delete">>,
      Expect<Equal<DatabaseQueryName, "notes.get" | "notes.search" | "notes.find">>,
      Expect<Equal<DatabaseMutationName, "notes.create" | "notes.update" | "notes.replace" | "notes.delete">>,
      Expect<Equal<DatabaseOperationInput<"notes.update">, { id: number; changes: { body?: string } }>>,
      Expect<Equal<DatabaseOperationOutput<"notes.delete">, void>>,
    ];

    export function Reads(selected: number | undefined) {
      const note = useDatabaseQuery("notes.get", { id: 1 });
      const loading: boolean = note.isLoading;
      const error: DatabaseApiError | null = note.error;
      note.refetch();
      const found = useDatabaseQuery("notes.find", { id: 1 });
      const search = useDatabaseQuery(
        "notes.search",
        { board_id: selected ?? 0 },
        { enabled: selected !== undefined },
      );
      const bodies: string[] | undefined = search.data?.map((row) => row.body);
      void [loading, error, bodies];
      return [
        true as Expect<Equal<typeof note.data, Note | undefined>>,
        // An explicit nullable answer keeps null apart from "not yet".
        true as Expect<Equal<typeof found.data, { id: number; body: string } | null | undefined>>,
      ];
    }

    export async function Writes() {
      const create = useDatabaseMutation("notes.create");
      const outcome = await create.mutate({ board_id: 1, body: "hi", total: "9007199254740993" });
      if (outcome.error === null) {
        const created: Note = outcome.data;
        void created;
      } else {
        const code: string = outcome.error.code;
        const nothing: undefined = outcome.data;
        void [code, nothing];
      }
      const removed = await useDatabaseMutation("notes.delete").mutate({ id: 1 });
      await useDatabaseMutation("notes.update").mutate({ id: 1, changes: {} });
      await useDatabaseMutation("notes.replace").mutate({ id: 1, values: { body: "x" } });
      create.reset();
      return [
        true as Expect<Equal<typeof create.data, Note | undefined>>,
        true as Expect<Equal<typeof create.isLoading, boolean>>,
        true as Expect<Equal<typeof removed, DatabaseMutationOutcome<void>>>,
      ];
    }

    export async function Client(signal: AbortSignal) {
      const note = await databaseApi.execute("notes.get", { id: 1 }, { signal });
      const removed = await databaseApi.execute("notes.delete", { id: 1 });
      const created = await databaseApi.execute("notes.create", { board_id: 1, body: "x" });
      return [
        true as Expect<Equal<typeof note, Note>>,
        true as Expect<Equal<typeof removed, void>>,
        true as Expect<Equal<typeof created, Note>>,
      ];
    }
  `);

  expect(diagnostics).toEqual([]);
});

test("each misuse fails with its own diagnostic", () => {
  expectEachProbeRejected(`${IMPORTS}
${GENERATED}
export async function Rejected() {
  // @ts-expect-error TS2345 a write is not a query, so it never runs on mount
  useDatabaseQuery("notes.create", { board_id: 1, body: "x" });
  // @ts-expect-error TS2345 a read is not a mutation
  useDatabaseMutation("notes.get");
  // @ts-expect-error TS2345 names come from the generated registry
  useDatabaseQuery("notes.missing", { id: 1 });
  // @ts-expect-error TS2322 the input keeps its JSON types
  useDatabaseQuery("notes.get", { id: "1" });
  // @ts-expect-error TS2353 an undeclared input field is refused
  useDatabaseQuery("notes.get", { id: 1, secret: true });
  // @ts-expect-error TS2554 the input is required
  useDatabaseQuery("notes.get");
  // @ts-expect-error TS2353 query options are enabled only
  useDatabaseQuery("notes.get", { id: 1 }, { keepPreviousData: true });
  // @ts-expect-error TS2532 data is undefined until it arrives
  useDatabaseQuery("notes.get", { id: 1 }).data.body;
  // @ts-expect-error TS2345 required write fields stay required
  useDatabaseMutation("notes.create").mutate({ board_id: 1 });
  // @ts-expect-error TS2353 an undeclared write field is refused
  useDatabaseMutation("notes.create").mutate({ board_id: 1, body: "x", id: 9 });
  // @ts-expect-error TS2554 a mutation takes its input only through mutate
  useDatabaseMutation("notes.create", { board_id: 1, body: "x" });
  const outcome = await useDatabaseMutation("notes.create").mutate({ board_id: 1, body: "x" });
  // @ts-expect-error TS18048 the answer exists only once the outcome is narrowed
  outcome.data.id;
  // @ts-expect-error TS2339 a delete answers no body
  (await databaseApi.execute("notes.delete", { id: 1 })).id;
  // @ts-expect-error TS2345 the client takes generated names only
  await databaseApi.execute("notes.missing", {});
}
`);
});

test("no operation exists before generation fills the registry", () => {
  expectEachProbeRejected(`${IMPORTS}
export async function Unbound() {
  // @ts-expect-error TS2345 the empty registry declares no query
  useDatabaseQuery("notes.get", { id: 1 });
  // @ts-expect-error TS2345 the empty registry declares no mutation
  useDatabaseMutation("notes.create");
  // @ts-expect-error TS2345 the empty registry declares no operation
  await databaseApi.execute("notes.get", { id: 1 });
}
`);
});
