import path from "node:path";

import ts from "typescript";
import { expect, test } from "vitest";

const packageRoot =
  path.basename(process.cwd()) === "appkit-ui"
    ? process.cwd()
    : path.join(process.cwd(), "packages", "appkit-ui");

function compileTypeProbe(source: string): string[] {
  const configPath = path.join(packageRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    packageRoot,
  );
  const filename = path.join(packageRoot, "__type-tests__", "database.ts");
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
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
}

// Entries as `appkit generate-types` renders them (trusted facets omitted: the
// browser reads only `publicRow`, `includes`, and `api`), bound the same way.
const REGISTRY = `
  type Filter<T> = T & { and?: readonly Filter<T>[]; or?: readonly Filter<T>[] };
  type Text = string | { eq?: string; neq?: string; in?: readonly (string)[]; like?: string; ilike?: string; };
  type Int = number | { eq?: number; neq?: number; in?: readonly (number)[]; gt?: number; gte?: number; lt?: number; lte?: number; };
  type Big = bigint | { eq?: bigint; neq?: bigint; in?: readonly (bigint)[]; gt?: bigint; gte?: bigint; lt?: bigint; lte?: bigint; };

  interface Fixture {
    "users": {
      publicRow: { "slug": string; "name": string };
      includes: { "posts": { to: "posts"; many: true } };
      api: {
        insert: { "slug": string; "name": string };
        update: { "name"?: string };
        filters: Filter<{ "slug"?: Text; "name"?: Text }>;
        orderable: "slug" | "name";
        key: "slug";
      };
    };
    "posts": {
      publicRow: { "id": number; "user_slug": string; "title": string; "total": bigint; "payload": unknown | null };
      includes: {
        "users": { to: "users"; many: false };
        "comments": { to: "comments"; many: true };
      };
      api: {
        insert: { "user_slug": string; "title": string; "total": bigint; "payload"?: unknown | null };
        update: { "title"?: string; "total"?: bigint; "payload"?: unknown | null };
        filters: Filter<{ "id"?: Int; "user_slug"?: Text; "title"?: Text; "total"?: Big }>;
        orderable: "id" | "user_slug" | "title" | "total";
        key: "id";
      };
    };
    "comments": {
      publicRow: { "id": number; "post_id": number; "body": string };
      includes: { "posts": { to: "posts"; many: false } };
      api: {
        insert: { "post_id": number; "body": string };
        update: { "body"?: string };
        filters: Filter<{ "id"?: Int; "post_id"?: Int; "body"?: Text }>;
        orderable: "id" | "post_id" | "body";
        key: "id";
      };
    };
    "ledger": {
      publicRow: { "seq": bigint; "note": string };
      includes: {};
      api: {
        insert: { "seq": bigint; "note": string };
        update: { "note"?: string };
        filters: Filter<{ "seq"?: Big; "note"?: Text }>;
        orderable: "seq" | "note";
        key: "seq";
      };
    };
    "sessions": {
      publicRow: { "user_slug": string };
      includes: { "users": { to: "users"; many: false } };
      api: {
        insert: { "user_slug": string };
        update: { "user_slug"?: string };
        filters: Filter<{ "user_slug"?: Text }>;
        orderable: "user_slug";
        key: never;
      };
    };
    "events": {
      publicRow: { "message": string };
      includes: {};
      api: {
        insert: { "message": string };
        update: { "message"?: string };
        filters: Filter<{ "message"?: Text }>;
        orderable: "message";
        key: never;
      };
    };
  }

  declare module "@databricks/appkit-ui/js/beta" {
    interface DatabaseRegistry extends Fixture {}
  }
`;

test("read hooks type entities, params, and rows from the generated registry", () => {
  const diagnostics = compileTypeProbe(`
    import { databaseApi } from "@databricks/appkit-ui/js/beta";
    import {
      type DatabaseEntity,
      type DatabaseKeyedEntity,
      useDatabaseList,
      useDatabaseRecord,
    } from "@databricks/appkit-ui/react/beta";

    ${REGISTRY}

    const keyed: DatabaseKeyedEntity[] = ["users", "posts", "comments", "ledger"];
    const listable: DatabaseEntity[] = ["sessions", "events"];
    void [keyed, listable];

    export function Lists() {
      const users = useDatabaseList("users", {
        where: { name: { ilike: "%ada%" } },
        include: { posts: { limit: 2, select: ["title", "total"] } },
      });
      const title: string | undefined = users.data?.items[0]?.posts[0]?.title;
      // A bigint travels as its decimal string.
      const total: string | undefined = users.data?.items[0]?.posts[0]?.total;
      // @ts-expect-error unselected relation columns are absent
      users.data?.items[0]?.posts[0]?.user_slug;
      const failed: "NOT_EXPOSED" | "NOT_FOUND" | undefined =
        users.error?.code === "NOT_EXPOSED" || users.error?.code === "NOT_FOUND"
          ? users.error.code
          : undefined;
      users.refetch();

      const posts = useDatabaseList("posts", { include: { users: true, comments: { limit: 3 } } });
      const owner: { slug: string; name: string } | null | undefined = posts.data?.items[0]?.users;
      const bodies: string[] | undefined = posts.data?.items[0]?.comments.map((c) => c.body);
      const nested = useDatabaseList("users", { include: { posts: { include: { comments: { limit: 1 } } } } });
      const deep: number | undefined = nested.data?.items[0]?.posts[0]?.comments[0]?.id;
      const gated = useDatabaseList("posts", { where: { id: 1 } }, { enabled: false });
      const gatedTitle: string | undefined = gated.data?.items[0]?.title;
      useDatabaseList("sessions", { order: { user_slug: "asc" } });
      useDatabaseList("posts", { where: { total: { gt: "9007199254740993" } } });
      void [title, total, failed, owner, bodies, deep, gatedTitle];
    }

    export function RejectedLists() {
      // @ts-expect-error entities are generated table names
      useDatabaseList("missing");
      // @ts-expect-error private columns are absent from public rows
      useDatabaseList("users").data?.items[0]?.secret;
      // @ts-expect-error private columns are not HTTP filters, even beside a valid one
      useDatabaseList("users", { where: { name: "Ada", secret: "token" } });
      // @ts-expect-error private columns are not selectable
      useDatabaseList("users", { select: ["slug", "secret"] });
      // @ts-expect-error JSON columns are not queryable
      useDatabaseList("posts", { where: { payload: { eq: 1 } } });
      // @ts-expect-error a to-one relation is one row, not an array
      useDatabaseList("posts", { include: { users: true } }).data?.items[0]?.users?.length;
      // @ts-expect-error a to-one include takes no limit
      useDatabaseList("posts", { include: { users: { limit: 1 } } });
      // @ts-expect-error includes stop at two relation edges
      useDatabaseList("users", { include: { posts: { include: { comments: { include: { posts: true } } } } } });
      // @ts-expect-error list params are the generated route's parameters only
      useDatabaseList("users", { limit: 1, includeTotal: true });
    }

    export function Records(boardId: number | undefined) {
      const post = useDatabaseRecord("posts", 7, { include: { comments: { limit: 20 } } });
      const body: string | undefined = post.data?.comments[0]?.body;
      const title: string | undefined = post.data?.title;
      const user = useDatabaseRecord("users", "ada", { select: ["name"] });
      const name: string | undefined = user.data?.name;
      // A null or undefined id waits without a request.
      useDatabaseRecord("posts", null);
      useDatabaseRecord("posts", boardId);
      // A bigint key is addressed by its decimal string, a safe integer, or a bigint.
      const seq: string | undefined = useDatabaseRecord("ledger", "9007199254740993").data?.seq;
      useDatabaseRecord("ledger", 10);
      useDatabaseRecord("ledger", 10n);
      void [body, title, name, seq];
    }

    export function RejectedRecords() {
      // @ts-expect-error keyless entities have no detail route
      useDatabaseRecord("events", "x");
      // @ts-expect-error a private key is not addressable over HTTP
      useDatabaseRecord("sessions", "token");
      // @ts-expect-error the id has the public key's type
      useDatabaseRecord("posts", "7");
      // @ts-expect-error record params are select and include only
      useDatabaseRecord("posts", 7, { where: { id: 7 } });
      // @ts-expect-error private columns are not selectable on a record
      useDatabaseRecord("users", "ada", { select: ["secret"] });
      // @ts-expect-error unselected columns are absent
      useDatabaseRecord("users", "ada", { select: ["name"] }).data?.slug;
    }

    export async function client() {
      const post = await databaseApi.get("posts", 7, { select: ["id", "title"] });
      const title: string = post.title;
      // @ts-expect-error unselected columns are absent
      post.total;
      // @ts-expect-error keyless entities have no detail route
      await databaseApi.get("events", "x");
      // @ts-expect-error record params are the generated route's parameters only
      await databaseApi.get("posts", 7, { select: ["id"], limit: 1 });
      void title;
    }
  `);

  expect(diagnostics).toEqual([]);
});

test("serialized<T>() replaces the row type and keeps entity, id, and params checked", () => {
  const diagnostics = compileTypeProbe(`
    import {
      type DatabaseListPage,
      type DatabaseReadResult,
      serialized,
      useDatabaseList,
      useDatabaseRecord,
    } from "@databricks/appkit-ui/react/beta";

    ${REGISTRY}

    interface PostCard { id: number; headline: string; comment_count: number }

    export function Shaped() {
      const cards = useDatabaseList(
        "posts",
        { order: { id: "desc" }, limit: 5 },
        { shape: serialized<PostCard>() },
      );
      const typed: DatabaseReadResult<DatabaseListPage<PostCard>> = cards;
      const headline: string | undefined = cards.data?.items[0]?.headline;
      // @ts-expect-error the shaped row replaces the inferred one
      cards.data?.items[0]?.title;

      const card = useDatabaseRecord("posts", 7, undefined, {
        shape: serialized<PostCard>(),
        enabled: false,
      });
      const count: number | undefined = card.data?.comment_count;
      void [typed, headline, count];
    }

    export function StillChecked() {
      // @ts-expect-error the entity stays checked with a shape
      useDatabaseList("missing", {}, { shape: serialized<PostCard>() });
      // @ts-expect-error private filters stay rejected with a shape
      useDatabaseList("users", { where: { secret: "token" } }, { shape: serialized<PostCard>() });
      // @ts-expect-error unknown params stay rejected with a shape
      useDatabaseList("users", { includeTotal: true }, { shape: serialized<PostCard>() });
      // @ts-expect-error includes stay bounded with a shape
      useDatabaseList("posts", { include: { users: { limit: 1 } } }, { shape: serialized<PostCard>() });
      // @ts-expect-error keyless entities stay rejected with a shape
      useDatabaseRecord("events", "x", {}, { shape: serialized<PostCard>() });
      // @ts-expect-error the id stays checked with a shape
      useDatabaseRecord("posts", "7", {}, { shape: serialized<PostCard>() });
      // @ts-expect-error record params stay checked with a shape
      useDatabaseRecord("users", "ada", { select: ["secret"] }, { shape: serialized<PostCard>() });
      // @ts-expect-error a shape is only built by serialized<T>()
      useDatabaseList("posts", {}, { shape: { headline: "x" } });
    }
  `);

  expect(diagnostics).toEqual([]);
});

test("no entity exists before typegen binds the registry", () => {
  const diagnostics = compileTypeProbe(`
    import { useDatabaseList, useDatabaseRecord } from "@databricks/appkit-ui/react/beta";

    export function Unbound() {
      // @ts-expect-error the empty registry binds no entity
      useDatabaseList("notes");
      // @ts-expect-error the empty registry binds no keyed entity
      useDatabaseRecord("notes", 1);
    }
  `);

  expect(diagnostics).toEqual([]);
});
