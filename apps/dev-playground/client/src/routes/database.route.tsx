import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@databricks/appkit-ui/react";
import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

import { BoardExplorer } from "@/components/database";
import { Header } from "@/components/layout/header";

export const Route = createFileRoute("/database")({
  component: DatabaseRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

function CodeBlock({
  code,
  lang = "typescript",
}: {
  code: string;
  lang?: string;
}) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    codeToHtml(code, { lang, theme: "dark-plus" }).then(setHtml);
  }, [code, lang]);

  return (
    <div
      className="rounded-md overflow-hidden [&>pre]:m-0 [&>pre]:p-4 [&>pre]:text-sm [&>pre]:overflow-x-auto font-mono"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const SCHEMA_EXAMPLE = `// config/database/schema.ts
export const schema = defineSchema(({ table }) => {
  const boards = table("boards", {
    id: id(),
    slug: varchar(64).notNull().unique(),
    title: text().notNull(),
    created_at: timestamp({ withTimezone: true })
      .defaultNow()
      .notNull(),
  });

  const notes = table("notes", {
    id: id(),
    board_id: fk(() => boards.id)
      .notNull()
      .onDelete("cascade"),
    author: text().notNull(),
    // The server needs it; no client should see it.
    author_email: text().private(),
    body: text().notNull(),
    created_at: timestamp({ withTimezone: true })
      .defaultNow()
      .notNull(),
  });

  const note_events = table("note_events", {
    id: id(),
    note_id: fk(() => notes.id)
      .notNull()
      .onDelete("cascade"),
    action: varchar(32).notNull(),
    created_at: timestamp({ withTimezone: true })
      .defaultNow()
      .notNull(),
  });

  return { boards, notes, note_events };
});`;

const OPERATION_EXAMPLE = `// server/database/routes/notes.ts
export const createNote = defineOperation({
  name: "notes.create",
  entity: "notes",
  method: "POST",
  input: z.object({ board_id: z.number().int(), body }),
  authorize: signedIn,
  execute: ({ actor, db, input }) =>
    db.transaction(async (tx) => {
      const note = await tx.notes.create({
        board_id: input.board_id,
        body: input.body,
        author: actor.id,
        author_email: actor.email ?? null,
      });
      await tx.note_events.create({ note_id: note.id, action: "created" });
      return note;
    }),
});`;

const POLICY_EXAMPLE = `// server/database/policies.ts
export const signedIn = definePolicy({ allow: () => true });

export const noteAuthor = definePolicy({
  resource: ({ db, input }: PolicyContext<{ readonly id: number }>) =>
    db.notes.find(input.id),
  allow: ({ actor, resource }) =>
    resource.author === actor.id ? true : { deny: "forbidden" },
});

// server/database/routes/notes.ts
export const updateNote = defineOperation({
  name: "notes.update",
  entity: "notes",
  method: "PATCH",
  input: z.object({ id: z.number().int(), body }),
  authorize: noteAuthor,
  execute: ({ db, input }) => /* ... */,
});`;

const REGISTRATION = `// server/database/routes.gen.ts, written by the AppKit Vite plugin
export const databaseRoutes = {
  schema: () => import("../../config/database/schema"),
  modules: [
    { file: "server/database/routes/boards.ts", load: () => import("./routes/boards") },
    { file: "server/database/routes/notes.ts", load: () => import("./routes/notes") },
  ],
} satisfies DatabaseRoutes;

// server/index.ts, inside createApp({ plugins: [...] })
database({ routes: databaseRoutes })`;

const HOOKS_EXAMPLE = `import {
  useDatabaseMutation,
  useDatabaseQuery,
} from "@databricks/appkit-ui/react/beta";

// Names, inputs, and outputs come from shared/appkit-types/database-operations.d.ts.
const notes = useDatabaseQuery("notes.list", { board_id: board.id });
const createNote = useDatabaseMutation("notes.create");

// A write runs only when you call mutate. On success, mounted queries refetch.
const { error } = await createNote.mutate({ board_id: board.id, body });`;

/** The operations server/database/routes/ declares, as the server publishes them. */
const OPERATIONS = [
  { name: "boards.list", method: "GET", policy: "signedIn" },
  { name: "boards.create", method: "POST", policy: "signedIn" },
  { name: "notes.list", method: "GET", policy: "signedIn" },
  { name: "notes.create", method: "POST", policy: "signedIn" },
  { name: "notes.update", method: "PATCH", policy: "noteAuthor" },
  { name: "notes.delete", method: "DELETE", policy: "noteAuthor" },
] as const;

const METHOD_TONE: Record<(typeof OPERATIONS)[number]["method"], string> = {
  GET: "text-emerald-600 dark:text-emerald-400",
  POST: "text-blue-600 dark:text-blue-400",
  PATCH: "text-amber-600 dark:text-amber-400",
  DELETE: "text-red-600 dark:text-red-400",
};

function OperationTable() {
  return (
    <div className="rounded-md border divide-y">
      {OPERATIONS.map((operation) => (
        <div
          key={operation.name}
          className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 px-3 py-2"
        >
          <code
            className={`text-xs font-bold w-16 shrink-0 ${METHOD_TONE[operation.method]}`}
          >
            {operation.method}
          </code>
          <code className="text-xs sm:w-96 shrink-0">
            /api/database/operations/{operation.name}
          </code>
          <code className="text-xs text-muted-foreground">
            {operation.policy}
          </code>
        </div>
      ))}
    </div>
  );
}

function DatabaseRoute() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <Header
          title="Database"
          description="Declare a Postgres schema, write each operation the app needs with its own authorization, and call it from React by name."
          tooltip="The DatabasePlugin reads an explicit schema. It never creates or migrates tables; at startup it checks that every declared table and column exists. Over HTTP it serves only the operations in server/database/routes/."
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>Live</CardTitle>
              <CardDescription>
                Boards, their notes, and the events each write records. Every
                request below calls one named operation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BoardExplorer />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>1. Declare the schema</CardTitle>
              <CardDescription>
                Columns and foreign keys in TypeScript. The plugin expects these
                tables to already exist; it owns no migrations.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock code={SCHEMA_EXAMPLE} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>2. Write an operation</CardTitle>
              <CardDescription>
                <code className="text-xs">execute</code> receives the verified
                actor, the database, and the input its Zod schema parsed. The
                note and its event commit together or not at all.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock code={OPERATION_EXAMPLE} />
            </CardContent>
          </Card>

          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>3. Authorize it</CardTitle>
              <CardDescription>
                Every operation needs <code className="text-xs">authorize</code>
                . Without a verified caller the plugin answers 401 before any
                policy runs, and only a literal{" "}
                <code className="text-xs">true</code> admits.{" "}
                <code className="text-xs">noteAuthor</code> loads the note once,
                refuses everyone but its author with 403, and hands the note to{" "}
                <code className="text-xs">execute</code>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock code={POLICY_EXAMPLE} />
            </CardContent>
          </Card>

          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>4. Serve the generated registry</CardTitle>
              <CardDescription>
                The AppKit Vite plugin lists every module in{" "}
                <code className="text-xs">server/database/routes/</code> and
                writes the browser contract of each operation. Without{" "}
                <code className="text-xs">routes</code>, the plugin serves no
                HTTP endpoint at all.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <CodeBlock code={REGISTRATION} />
              <OperationTable />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>5. Call it by name</CardTitle>
              <CardDescription>
                Queries take GET operations and mutations take the rest. A name
                the server did not publish sends no request.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CodeBlock code={HOOKS_EXAMPLE} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Private columns</CardTitle>
              <CardDescription>
                <code className="text-xs">private()</code> marks a column only
                server code reads and writes.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                <code>notes.create</code> stores the caller's email in{" "}
                <code>author_email</code> without ever accepting it as input. A
                default output, like the row <code>notes.create</code> answers
                with, drops private columns. An explicit output, like the one{" "}
                <code>notes.list</code> declares, answers with exactly the
                fields its schema names.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
