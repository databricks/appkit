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
import { Loader2, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

/**
 * Everything on this panel comes from routes the app never wrote: the note list
 * is a generated read, the two forms are generated writes, and the audit trail
 * is the row an `afterCreate` hook commits alongside each note.
 */

interface Note {
  id: number;
  board_id: number;
  author: string;
  body: string;
  created_at: string;
}

interface Board {
  id: number;
  slug: string;
  title: string;
  created_at: string;
  notes?: Note[];
}

interface NoteEvent {
  id: number;
  note_id: number;
  action: string;
  created_at: string;
}

interface TimelineNote extends Note {
  note_events?: NoteEvent[];
}

interface Timeline extends Board {
  notes?: TimelineNote[];
}

/** The include is bounded to `notes` because that is the only exposed relation. */
const BOARDS_URL = `/api/database/boards?include=${encodeURIComponent(
  JSON.stringify({ notes: { limit: 5 } }),
)}`;

/** Listing notes directly is what puts them through the entity's serializer. */
const notesUrl = (boardId: number) =>
  `/api/database/notes?where=${encodeURIComponent(
    JSON.stringify({ board_id: boardId }),
  )}&order=${encodeURIComponent(
    JSON.stringify({ created_at: "desc" }),
  )}&limit=5`;

/** Generated routes answer failures as `{ error, details? }`. */
function failureMessage(body: unknown, fallback: string): string {
  const payload = body as {
    error?: unknown;
    details?: Array<{ message?: string }>;
  } | null;
  const detail = payload?.details?.[0]?.message;
  if (typeof detail === "string") return detail;
  return typeof payload?.error === "string" ? payload.error : fallback;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(failureMessage(body, `HTTP ${response.status}`));
  }
  return body as T;
}

export function BoardExplorer() {
  const authorFieldId = useId();
  const bodyFieldId = useId();
  const boardFieldId = useId();

  const [boards, setBoards] = useState<Board[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [fullBody, setFullBody] = useState<Record<number, string>>({});
  const [author, setAuthor] = useState("reviewer");
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (slug?: string | null) => {
    setError(null);
    try {
      const page = await getJson<{ items: Board[] }>(BOARDS_URL);
      setBoards(page.items);
      const active =
        page.items.find((entry) => entry.slug === slug) ?? page.items[0];
      setSelected(active?.slug ?? null);
      setFullBody({});
      if (!active) {
        setNotes([]);
        setTimeline(null);
        return;
      }
      const [listed, board] = await Promise.all([
        getJson<{ items: Note[] }>(notesUrl(active.id)),
        getJson<Timeline>(`/api/boards/${active.slug}/timeline`),
      ]);
      setNotes(listed.items);
      setTimeline(board);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const board = boards.find((entry) => entry.slug === selected) ?? null;

  const post = async (url: string, payload: unknown) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const created: unknown = await response.json();
    if (!response.ok) throw new Error(failureMessage(created, "Create failed"));
    return created;
  };

  const submit = async (run: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      const slug = await run();
      await load(slug ?? selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const addNote = (event: React.FormEvent) => {
    event.preventDefault();
    if (!board || !body.trim()) return;
    return submit(async () => {
      await post("/api/database/notes", {
        board_id: board.id,
        author,
        body,
      });
      setBody("");
      return board.slug;
    });
  };

  const addBoard = (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const slug = title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    return submit(async () => {
      await post("/api/database/boards", { slug, title: title.trim() });
      setTitle("");
      return slug;
    });
  };

  /** The list route truncates; the detail route does not. Same serializer. */
  const revealFullBody = async (id: number) => {
    const note = await getJson<Note>(`/api/database/notes/${id}`);
    setFullBody((current) => ({ ...current, [id]: note.body }));
  };

  const eventsByNote = new Map(
    (timeline?.notes ?? []).map((note) => [note.id, note.note_events ?? []]),
  );

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
        {boards.map((entry) => (
          <Button
            key={entry.slug}
            size="sm"
            variant={entry.slug === selected ? "default" : "outline"}
            onClick={() => load(entry.slug)}
          >
            {entry.title}
            <Badge
              variant="secondary"
              className="ml-2 tabular-nums font-normal"
            >
              {entry.notes?.length ?? 0} notes
            </Badge>
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => load(selected)}
          aria-label="Reload"
        >
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
            {notes.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No notes yet. Add one and watch the audit trail fill in.
              </p>
            )}
            {notes.map((note) => (
              <div key={note.id} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-sm font-medium">{note.author}</span>
                  <Badge variant="outline" className="tabular-nums">
                    {(fullBody[note.id] ?? note.body).length} chars
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground break-words">
                  {fullBody[note.id] ?? note.body}
                </p>
                {!fullBody[note.id] && note.body.length === 120 && (
                  <Button
                    size="sm"
                    variant="link"
                    className="px-0 h-auto text-xs"
                    onClick={() => revealFullBody(note.id)}
                  >
                    Truncated by the serializer — load the detail route instead
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Audit trail written by a hook
            </CardTitle>
            <CardDescription>
              <code className="text-xs break-all">
                GET /api/boards/{selected ?? ":slug"}/timeline
              </code>{" "}
              — <code className="text-xs">note_events</code> has no route of its
              own, so only the server-side client can reach it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(timeline?.notes ?? []).map((note) => (
              <div key={note.id} className="rounded-md border p-3">
                <div className="text-sm font-medium mb-1">
                  note #{note.id} by {note.author}
                </div>
                <ul className="space-y-1">
                  {(eventsByNote.get(note.id) ?? []).map((event) => (
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
            {(timeline?.notes ?? []).length === 0 && (
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
