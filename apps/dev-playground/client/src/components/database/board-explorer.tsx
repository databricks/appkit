import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@databricks/appkit-ui/react";
import {
  type DatabaseApiError,
  useDatabaseCreate,
  useDatabaseList,
  useDatabaseRecord,
} from "@databricks/appkit-ui/react/beta";
import { Loader2, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useId, useState } from "react";

/**
 * Everything on this panel comes from routes the app never wrote: the note list
 * is a generated read, the two forms are generated writes, and the audit trail
 * is the row an `afterCreate` hook commits alongside each note.
 */

/** Generated routes answer `{ error, details? }`; a field detail reads first. */
function errorText(err: DatabaseApiError): string {
  return err.details[0]?.message ?? err.message;
}

export function BoardExplorer() {
  const authorFieldId = useId();
  const bodyFieldId = useId();
  const boardFieldId = useId();

  const [selected, setSelected] = useState<string | null>(null);
  const [revealedId, setRevealedId] = useState<number | null>(null);
  const [author, setAuthor] = useState("reviewer");
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");

  // A write restarts every mounted read, so the lists, the board previews, and
  // the audit trail `afterCreate` writes refresh on their own once it commits.
  const createBoard = useDatabaseCreate("boards");
  const createNote = useDatabaseCreate("notes");
  const busy = createBoard.loading || createNote.loading;

  // Only a short note preview is needed for the board picker.
  const boards = useDatabaseList("boards", {
    include: { notes: { limit: 5 } },
  });
  const boardItems = boards.data?.items ?? [];
  const board =
    boardItems.find((entry) => entry.slug === selected) ?? boardItems[0];

  // Listing notes directly is what puts them through the entity's serializer.
  const notes = useDatabaseList(
    "notes",
    {
      where: { board_id: board?.id ?? 0 },
      order: { created_at: "desc" },
      limit: 5,
    },
    { enabled: board !== undefined },
  );
  const noteItems = notes.data?.items ?? [];

  // The audit trail is a read-only include on the generated board detail route.
  const timeline = useDatabaseRecord("boards", board?.id, {
    include: { notes: { limit: 20, include: { note_events: { limit: 5 } } } },
  });
  const timelineNotes = timeline.data?.notes ?? [];

  // The list route truncates; the detail route does not. Same serializer.
  const fullNote = useDatabaseRecord("notes", revealedId);

  const failure =
    createNote.error ??
    createBoard.error ??
    boards.error ??
    notes.error ??
    timeline.error ??
    fullNote.error;
  const error = failure ? errorText(failure) : null;

  const refresh = () => {
    boards.refetch();
    notes.refetch();
    timeline.refetch();
    fullNote.refetch();
  };

  const selectBoard = (slug: string) => {
    setSelected(slug);
    setRevealedId(null);
  };

  const addNote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!board || !body.trim()) return;
    createBoard.reset();
    // A failure resolves null and lands in createNote.error for the banner.
    const created = await createNote.create({
      board_id: board.id,
      author,
      body,
    });
    if (created) setBody("");
  };

  const addBoard = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const slug = title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    createNote.reset();
    // A failure resolves null and lands in createBoard.error for the banner.
    const created = await createBoard.create({ slug, title: title.trim() });
    if (!created) return;
    setTitle("");
    selectBoard(created.slug);
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-muted/30 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Board
        </span>
        {boardItems.map((entry) => (
          <Button
            key={entry.slug}
            size="sm"
            variant={entry.slug === board?.slug ? "default" : "outline"}
            onClick={() => selectBoard(entry.slug)}
          >
            {entry.title}
            <Badge
              variant="secondary"
              className="ml-2 tabular-nums font-normal"
            >
              {entry.notes.length} notes
            </Badge>
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={refresh} aria-label="Reload">
          <RefreshCwIcon className="h-4 w-4" />
        </Button>

        <form onSubmit={addBoard} className="flex items-center gap-2 ml-auto">
          <label htmlFor={boardFieldId} className="sr-only">
            New board title
          </label>
          <Input
            id={boardFieldId}
            value={title}
            placeholder="New board title"
            onChange={(event) => setTitle(event.target.value)}
            className="h-8 w-48"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={busy || !title.trim()}
          >
            Create
          </Button>
        </form>
      </div>
      <p className="text-xs text-muted-foreground">
        The note counts above ride along on the board list as{" "}
        <code>?include={'{"notes":{"limit":5}}'}</code>. Creating a board is the
        second exposed table answering <code>POST /api/database/boards</code>.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Generated read</CardTitle>
            <CardDescription>
              <code className="text-xs break-all">
                GET /api/database/notes?where={"{"}"board_id":{board?.id ?? 0}
                {"}"}&amp;order={"{"}"created_at":"desc"{"}"}
              </code>{" "}
              — filters, ordering and pagination are decoded from the query
              string against the schema, never interpolated into SQL.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!notes.loading && noteItems.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No notes yet. Add one and watch the audit trail fill in.
              </p>
            )}
            {noteItems.map((note) => {
              const full =
                note.id === revealedId ? fullNote.data?.body : undefined;
              return (
                <div key={note.id} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm font-medium">{note.author}</span>
                    <Badge variant="outline" className="tabular-nums">
                      {(full ?? note.body).length} chars
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground break-words">
                    {full ?? note.body}
                  </p>
                  {full === undefined && note.body.length === 120 && (
                    <Button
                      size="sm"
                      variant="link"
                      className="px-0 h-auto text-xs"
                      onClick={() => setRevealedId(note.id)}
                    >
                      Truncated by the serializer — load the detail route
                      instead
                    </Button>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Audit trail written by a hook
            </CardTitle>
            <CardDescription>
              <code className="text-xs break-all">
                GET /api/database/boards/{board?.id ?? ":id"}?include=…
              </code>{" "}
              reads notes and their events through nested includes. The
              generated API exposes <code className="text-xs">note_events</code>{" "}
              for reading only; the hook writes it inside the note's
              transaction.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {timelineNotes.map((note) => (
              <div key={note.id} className="rounded-md border p-3">
                <div className="text-sm font-medium mb-1">
                  note #{note.id} by {note.author}
                </div>
                <ul className="space-y-1">
                  {note.note_events.map((event) => (
                    <li
                      key={event.id}
                      className="text-xs text-muted-foreground flex items-center gap-2"
                    >
                      <Badge variant="secondary">{event.action}</Badge>
                      <span className="tabular-nums">
                        {new Date(event.created_at).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {!timeline.loading && timelineNotes.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nothing recorded yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Generated write</CardTitle>
          <CardDescription>
            <code className="text-xs">POST /api/database/notes</code> — the note
            and its <code className="text-xs">created</code> event commit
            together or not at all.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={addNote} className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label htmlFor={authorFieldId} className="text-xs font-medium">
                author
              </label>
              <Input
                id={authorFieldId}
                value={author}
                onChange={(event) => setAuthor(event.target.value)}
                className="w-40"
              />
            </div>
            <div className="space-y-1 flex-1 min-w-[220px]">
              <label htmlFor={bodyFieldId} className="text-xs font-medium">
                body
              </label>
              <Input
                id={bodyFieldId}
                value={body}
                placeholder="Write more than 120 characters to see the serializer work"
                onChange={(event) => setBody(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy || !board || !body.trim()}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <PlusIcon className="h-4 w-4" />
              )}
              Add note
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
