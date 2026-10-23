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
  type DatabaseOperationOutput,
  useDatabaseMutation,
  useDatabaseQuery,
} from "@databricks/appkit-ui/react/beta";
import {
  CheckIcon,
  Loader2,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useId, useState } from "react";

type Note = DatabaseOperationOutput<"notes.list">[number];

/** Operations answer `{ error, details? }`; a field detail reads first. */
function errorText(error: DatabaseApiError): string {
  return error.details[0]?.message ?? error.message;
}

/**
 * Everything on this panel calls a named operation from
 * server/database/routes/. Only a note's author may edit or delete it; the
 * buttons are on every note so a refusal from the server shows up here.
 */
export function BoardExplorer() {
  const boardFieldId = useId();
  const bodyFieldId = useId();

  const [selected, setSelected] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // The latest write's outcome. Each mutation restarts the queries on success.
  const [failure, setFailure] = useState<DatabaseApiError | null>(null);

  const boards = useDatabaseQuery("boards.list", {});
  const board =
    boards.data?.find((entry) => entry.id === selected) ?? boards.data?.[0];
  const notes = useDatabaseQuery(
    "notes.list",
    { board_id: board?.id ?? 0 },
    { enabled: board !== undefined },
  );

  const createBoard = useDatabaseMutation("boards.create");
  const createNote = useDatabaseMutation("notes.create");
  const updateNote = useDatabaseMutation("notes.update");
  const deleteNote = useDatabaseMutation("notes.delete");
  const busy =
    createBoard.isLoading ||
    createNote.isLoading ||
    updateNote.isLoading ||
    deleteNote.isLoading;

  const error = failure ?? boards.error ?? notes.error;

  const addBoard = async (event: React.FormEvent) => {
    event.preventDefault();
    const outcome = await createBoard.mutate({ title: title.trim() });
    setFailure(outcome.error);
    if (outcome.error !== null) return;
    setTitle("");
    setSelected(outcome.data.id);
  };

  const addNote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!board) return;
    const outcome = await createNote.mutate({
      board_id: board.id,
      body: body.trim(),
    });
    setFailure(outcome.error);
    if (outcome.error === null) setBody("");
  };

  const saveNote = async (id: number, next: string) => {
    const outcome = await updateNote.mutate({ id, body: next });
    setFailure(outcome.error);
    return outcome.error === null;
  };

  const removeNote = async (id: number) => {
    const outcome = await deleteNote.mutate({ id });
    setFailure(outcome.error);
  };

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {errorText(error)}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border bg-muted/30 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Board
        </span>
        {boards.data?.map((entry) => (
          <Button
            key={entry.id}
            size="sm"
            variant={entry.id === board?.id ? "default" : "outline"}
            onClick={() => setSelected(entry.id)}
          >
            {entry.title}
            <Badge
              variant="secondary"
              className="ml-2 tabular-nums font-normal"
            >
              {entry.note_count} {entry.note_count === 1 ? "note" : "notes"}
            </Badge>
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            boards.refetch();
            notes.refetch();
          }}
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
            Create board
          </Button>
        </form>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notes and their events</CardTitle>
            <CardDescription>
              <code className="text-xs break-all">
                {`useDatabaseQuery("notes.list", { board_id: ${board?.id ?? 0} })`}
              </code>{" "}
              reads the board's newest notes, each with the events written in
              the same transaction.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!notes.isLoading && notes.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No notes yet. Add one.
              </p>
            )}
            {notes.data?.map((note) => (
              <NoteItem
                key={note.id}
                note={note}
                busy={busy}
                onSave={saveNote}
                onDelete={removeNote}
              />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a note</CardTitle>
            <CardDescription>
              <code className="text-xs">notes.create</code> takes only the board
              and the body. The server sets the author from the signed-in user
              and writes the note and its{" "}
              <code className="text-xs">created</code> event in one transaction.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={addNote} className="flex flex-wrap items-end gap-3">
              <div className="space-y-1 flex-1 min-w-[220px]">
                <label htmlFor={bodyFieldId} className="text-xs font-medium">
                  body
                </label>
                <Input
                  id={bodyFieldId}
                  value={body}
                  placeholder="Write a note"
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
    </div>
  );
}

function NoteItem({
  note,
  busy,
  onSave,
  onDelete,
}: {
  note: Note;
  busy: boolean;
  onSave: (id: number, body: string) => Promise<boolean>;
  onDelete: (id: number) => Promise<void>;
}) {
  // The body being edited, or null while the note is only shown.
  const [draft, setDraft] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (draft !== null && (await onSave(note.id, draft.trim()))) {
      setDraft(null);
    }
  };

  return (
    <div className="rounded-md border p-3 space-y-2" data-note-id={note.id}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium break-all">{note.author}</span>
        {draft === null && (
          <div className="flex gap-1 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft(note.body)}
              aria-label={`Edit note ${note.id}`}
            >
              <PencilIcon className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onDelete(note.id)}
              aria-label={`Delete note ${note.id}`}
            >
              <Trash2Icon className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>
      {draft === null ? (
        <p className="text-sm text-muted-foreground break-words">{note.body}</p>
      ) : (
        <form onSubmit={save} className="flex items-center gap-2">
          <Input
            value={draft}
            aria-label={`New body for note ${note.id}`}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            disabled={busy || !draft.trim()}
            aria-label="Save"
          >
            <CheckIcon className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setDraft(null)}
            aria-label="Cancel"
          >
            <XIcon className="h-3 w-3" />
          </Button>
        </form>
      )}
      <ul className="flex flex-wrap gap-2">
        {note.note_events.map((event) => (
          <li
            key={event.id}
            className="text-xs text-muted-foreground flex items-center gap-1"
          >
            <Badge variant="secondary">{event.action}</Badge>
            <span className="tabular-nums">
              {new Date(event.created_at).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
