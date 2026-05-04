import {
  type ReactElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useForm, useFormState } from "react-hook-form";
import type {
  ColumnInfo,
  DatabaseClient,
  DatabaseEntityKey,
  DatabaseInsert,
} from "@/js";
import { db } from "@/js";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  coerceFormValues,
  EntityFormFields,
  filterCreateColumns,
  filterEditColumns,
  getDefaultValues,
  toPatchPayload,
} from "./entity-form";
import type { CreateEntityProps, EditEntityProps, RowOf } from "./types";
import { EntityError, EntityLoading } from "./view-entity";

// ---------------------------------------------------------------------------
// Public components — thin wrappers around the shared dialog.
// ---------------------------------------------------------------------------

/**
 * Controlled modal that renders create fields from column metadata and POSTs
 * through `db.<entity>.create(...)`.
 */
export function CreateEntity<E extends DatabaseEntityKey>(
  props: CreateEntityProps<E>,
): ReactElement {
  return (
    <EntityMutationDialog<E>
      mode="create"
      entity={props.entity}
      variant={props.variant}
      open={props.open}
      onOpenChange={props.onOpenChange}
      onSuccess={props.onSuccess}
      defaults={props.defaults}
      fields={props.fields}
      title={props.title}
      description={props.description}
      testId={props.testId}
    />
  );
}

/**
 * Controlled modal that loads a row by `id`, renders editable non-PK fields,
 * and PATCHes through `db.<entity>.update(...)`.
 */
export function EditEntity<E extends DatabaseEntityKey>(
  props: EditEntityProps<E>,
): ReactElement {
  return (
    <EntityMutationDialog<E>
      mode="edit"
      entity={props.entity}
      id={props.id}
      variant={props.variant}
      open={props.open}
      onOpenChange={props.onOpenChange}
      onSuccess={props.onSuccess}
      fields={props.fields}
      title={props.title}
      description={props.description}
      testId={props.testId}
    />
  );
}

// ---------------------------------------------------------------------------
// Internal shared dialog
// ---------------------------------------------------------------------------

interface EntityMutationDialogProps<E extends DatabaseEntityKey> {
  mode: "create" | "edit";
  entity: E;
  id?: string | number;
  variant?: "modal";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (row: RowOf<E>) => void;
  defaults?: Partial<DatabaseInsert<E>>;
  fields?: readonly string[];
  title?: string;
  description?: string;
  testId?: string;
}

function pickRowForColumns(
  row: Record<string, unknown>,
  columns: ColumnInfo[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    out[c.name] = row[c.name];
  }
  return out;
}

function EntityMutationDialog<E extends DatabaseEntityKey>(
  props: EntityMutationDialogProps<E>,
): ReactElement {
  const {
    mode,
    entity,
    id,
    variant = "modal",
    open,
    onOpenChange,
    onSuccess,
    defaults,
    fields,
    title,
    description,
    testId,
  } = props;

  const formId = useId();
  const [columnsMeta, setColumnsMeta] = useState<ColumnInfo[] | null>(null);
  const [columnsError, setColumnsError] = useState<string | null>(null);
  const [row, setRow] = useState<RowOf<E> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowLoading, setRowLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Load column metadata once when the dialog opens.
  useEffect(() => {
    if (!open) return;
    let active = true;
    const client = (db as DatabaseClient)[entity];
    client
      .columns()
      .then((cols) => {
        if (active) setColumnsMeta(cols);
      })
      .catch((err) => {
        if (active)
          setColumnsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [open, entity]);

  const { control, handleSubmit, reset, formState } = useForm<
    Record<string, unknown>
  >({ defaultValues: {} });
  const { dirtyFields } = useFormState({ control });
  const dirtySnapshotRef = useRef<
    Partial<Record<string, boolean | Record<string, unknown>>>
  >({});
  dirtySnapshotRef.current = dirtyFields;

  const formColumns = useMemo((): ColumnInfo[] => {
    if (!columnsMeta?.length) return [];
    return mode === "create"
      ? filterCreateColumns(columnsMeta, fields)
      : filterEditColumns(columnsMeta, fields);
  }, [columnsMeta, mode, fields]);

  useEffect(() => {
    if (!open) {
      reset({});
      setSubmitError(null);
      setRow(null);
      setLoadError(null);
    }
  }, [open, reset]);
  useEffect(() => {
    if (!open || mode !== "create") return;
    if (!formColumns.length) return;
    reset(
      getDefaultValues(
        formColumns,
        (defaults ?? {}) as Record<string, unknown>,
      ),
    );
    setSubmitError(null);
  }, [open, mode, formColumns, defaults, reset]);

  useEffect(() => {
    if (!open || mode !== "edit") return;
    if (id === "" || id === undefined) return;
    if (!formColumns.length) return;

    const ctrl = new AbortController();
    let active = true;
    setRowLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const client = (db as DatabaseClient)[entity];
        const found = (await client.find(id, ctrl.signal)) as RowOf<E> | null;
        if (!active) return;
        if (!found) {
          setLoadError("Row not found.");
          setRow(null);
          reset({});
          return;
        }
        setRow(found);
        reset(
          getDefaultValues(
            formColumns,
            pickRowForColumns(found as Record<string, unknown>, formColumns),
          ),
        );
      } catch (e) {
        if (ctrl.signal.aborted || !active) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        setRow(null);
        reset({});
      } finally {
        if (active) setRowLoading(false);
      }
    })();
    return () => {
      active = false;
      ctrl.abort();
    };
  }, [open, mode, entity, id, formColumns, reset]);

  const onValid = async (values: Record<string, unknown>) => {
    if (!formColumns.length) return;
    setSubmitError(null);
    try {
      const coerced = coerceFormValues(formColumns, values);
      const client = (db as DatabaseClient)[entity];

      if (mode === "create") {
        const created = (await client.create(coerced as never)) as RowOf<E>;
        onSuccess?.(created);
        onOpenChange(false);
        return;
      }

      const patch = toPatchPayload(
        coerced,
        dirtySnapshotRef.current,
        formColumns,
      );
      if (Object.keys(patch).length === 0) {
        onOpenChange(false);
        return;
      }
      const updated = (await client.update(
        id as string | number,
        patch as never,
      )) as RowOf<E>;
      onSuccess?.(updated);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  };

  if (variant !== "modal") {
    return (
      <EntityError
        message={`Unknown EntityMutationDialog variant "${String(variant)}".`}
      />
    );
  }

  const colsError = columnsError;
  const columnsLoading = columnsMeta === null && !colsError;
  const showSkeleton =
    open &&
    !colsError &&
    (columnsLoading ||
      (mode === "edit" &&
        !loadError &&
        (rowLoading ||
          (columnsMeta !== null &&
            columnsMeta.length > 0 &&
            !row &&
            formColumns.length > 0))));

  const headerTitle =
    title ??
    (mode === "create"
      ? `New ${String(entity)}`
      : `Edit ${String(entity)}${row ? ` — ${String(id)}` : ""}`);

  const defaultDescription =
    mode === "create"
      ? "Fill in the fields and create a new row. Generated columns are omitted."
      : "Update fields and save. Primary keys and generated columns are read-only.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={testId}
        className="max-h-[85vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{headerTitle}</DialogTitle>
          <DialogDescription>
            {description ?? defaultDescription}
          </DialogDescription>
        </DialogHeader>

        {colsError && <EntityError message={colsError} />}
        {mode === "edit" && loadError && !colsError && (
          <EntityError message={loadError} />
        )}
        {showSkeleton && <EntityLoading />}

        {!colsError &&
          !showSkeleton &&
          !(mode === "edit" && loadError) &&
          !(mode === "edit" && !row) &&
          formColumns.length > 0 && (
            <form
              id={formId}
              onSubmit={handleSubmit(onValid)}
              className="space-y-4"
            >
              <EntityFormFields
                idPrefix={`${formId}-${mode}`}
                columns={formColumns}
                control={control}
                disabled={formState.isSubmitting}
              />
              {submitError && (
                <p className="text-sm text-destructive">{submitError}</p>
              )}
            </form>
          )}

        {!colsError &&
          !showSkeleton &&
          !(mode === "edit" && loadError) &&
          !(mode === "edit" && !row) &&
          formColumns.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {mode === "create"
                ? "No creatable columns for this entity."
                : "No editable columns for this entity."}
            </p>
          )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={formState.isSubmitting}
          >
            Cancel
          </Button>
          {formColumns.length > 0 && (
            <Button
              type="submit"
              form={formId}
              disabled={
                formState.isSubmitting ||
                (mode === "edit" && (!row || !!loadError))
              }
            >
              {formState.isSubmitting
                ? mode === "create"
                  ? "Creating…"
                  : "Saving…"
                : mode === "create"
                  ? "Create"
                  : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
