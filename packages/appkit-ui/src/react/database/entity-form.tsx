import type { Ref } from "react";
import { type Control, Controller } from "react-hook-form";
import type { ColumnInfo } from "@/js";
import { formatFieldLabel } from "../lib/format";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

// ---------------------------------------------------------------------------
// Form utilities — pure functions for transforming column metadata into form
// defaults, coercing textarea values, and building PATCH payloads.
// ---------------------------------------------------------------------------

/** Columns shown on create: not generated (serial PKs, defaultNow, etc.). */
export function filterCreateColumns(
  columns: ColumnInfo[],
  fields?: readonly string[],
): ColumnInfo[] {
  let out = columns.filter((c) => !c.generated);
  if (fields?.length) {
    const allow = new Set(fields);
    out = out.filter((c) => allow.has(c.name));
  }
  return out;
}

/** Columns shown on edit: not generated, not primary key. */
export function filterEditColumns(
  columns: ColumnInfo[],
  fields?: readonly string[],
): ColumnInfo[] {
  let out = columns.filter((c) => !c.generated && !c.primaryKey);
  if (fields?.length) {
    const allow = new Set(fields);
    out = out.filter((c) => allow.has(c.name));
  }
  return out;
}

/**
 * Default form values for the given columns. Merges optional `base` (defaults
 * or a loaded row subset) then fills missing keys with type-appropriate blanks.
 */
export function getDefaultValues(
  columns: ColumnInfo[],
  base?: Record<string, unknown> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const c of columns) {
    if (out[c.name] !== undefined) continue;
    if (c.type === "boolean") out[c.name] = false;
    else if (c.nullable) out[c.name] = null;
    else out[c.name] = "";
  }
  return out;
}

/**
 * Build insert/update payload from raw form values; parses JSON fields from
 * textarea strings.
 */
export function coerceFormValues(
  columns: ColumnInfo[],
  draft: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columns) {
    if (!(col.name in draft)) continue;
    let v = draft[col.name];
    if (col.type === "json" && typeof v === "string") {
      const t = v.trim();
      if (t === "") v = null;
      else {
        try {
          v = JSON.parse(t) as unknown;
        } catch {
          throw new Error(`Invalid JSON for ${col.name}`);
        }
      }
    }
    if (col.type === "number" || col.type === "bigint") {
      if (v === "" || v === undefined) v = null;
    }
    if (col.type === "string" || col.type === "uuid") {
      if (v === "") v = col.nullable ? null : v;
    }
    out[col.name] = v;
  }
  return out;
}

/**
 * Build a PATCH body from coerced values and react-hook-form `dirtyFields`
 * (flat object shape).
 */
export function toPatchPayload(
  coerced: Record<string, unknown>,
  dirtyFields: Partial<Record<string, boolean | object>>,
  columns: ColumnInfo[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const col of columns) {
    if (dirtyFields[col.name] === true) patch[col.name] = coerced[col.name];
  }
  return patch;
}

// ---------------------------------------------------------------------------
// EntityFormFields — schema-driven form inputs wired to react-hook-form.
// ---------------------------------------------------------------------------

export interface EntityFormFieldsProps {
  idPrefix: string;
  columns: ColumnInfo[];
  control: Control<Record<string, unknown>>;
  disabled?: boolean;
  readOnlyNames?: ReadonlySet<string>;
}

/**
 * Schema-driven inputs wired to react-hook-form. One control per `ColumnInfo`;
 * parents filter columns via `filterCreateColumns` / `filterEditColumns`.
 */
export function EntityFormFields({
  idPrefix,
  columns,
  control,
  disabled,
  readOnlyNames,
}: EntityFormFieldsProps) {
  return (
    <div className="space-y-3">
      {columns.map((col) => (
        <Controller
          key={col.name}
          name={col.name}
          control={control}
          render={({ field }) => (
            <EntityField
              col={col}
              id={`${idPrefix}-${col.name}`}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              inputRef={field.ref}
              disabled={disabled}
              readOnly={readOnlyNames?.has(col.name) ?? false}
            />
          )}
        />
      ))}
    </div>
  );
}

function EntityField({
  col,
  id,
  value,
  onChange,
  onBlur,
  inputRef,
  disabled,
  readOnly,
}: {
  col: ColumnInfo;
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
  onBlur: () => void;
  inputRef: Ref<HTMLInputElement | HTMLTextAreaElement>;
  disabled?: boolean;
  readOnly: boolean;
}) {
  const label = formatFieldLabel(col.name);
  const ro = readOnly || disabled;

  if (col.type === "boolean") {
    const checked = Boolean(value);
    return (
      <div className="flex items-center gap-2">
        <input
          ref={inputRef as Ref<HTMLInputElement>}
          id={id}
          type="checkbox"
          className="h-4 w-4 rounded border"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          onBlur={onBlur}
          disabled={ro}
        />
        <Label htmlFor={id} className="font-normal cursor-pointer">
          {label}
        </Label>
      </div>
    );
  }

  if (col.type === "json") {
    const text =
      value === null || value === undefined
        ? ""
        : typeof value === "string"
          ? value
          : JSON.stringify(value, null, 2);
    return (
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <Textarea
          ref={inputRef as Ref<HTMLTextAreaElement>}
          id={id}
          rows={4}
          className="font-mono text-xs"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          disabled={ro}
        />
      </div>
    );
  }

  if (col.type === "number" || col.type === "bigint") {
    const n =
      typeof value === "number"
        ? value
        : typeof value === "string" && value !== ""
          ? Number(value)
          : "";
    return (
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <Input
          ref={inputRef as Ref<HTMLInputElement>}
          id={id}
          type="number"
          value={n === "" ? "" : n}
          onChange={(e) => {
            const raw = e.target.value;
            onChange(raw === "" ? null : Number(raw));
          }}
          onBlur={onBlur}
          disabled={ro}
        />
      </div>
    );
  }

  if (col.type === "date") {
    const iso =
      value instanceof Date
        ? value.toISOString()
        : typeof value === "string"
          ? value
          : "";
    const local = iso ? iso.slice(0, 16) : "";
    return (
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <Input
          ref={inputRef as Ref<HTMLInputElement>}
          id={id}
          type="datetime-local"
          value={local}
          onChange={(e) => {
            const v = e.target.value;
            onChange(v ? new Date(v).toISOString() : null);
          }}
          onBlur={onBlur}
          disabled={ro}
        />
      </div>
    );
  }

  // string, uuid, unknown
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        ref={inputRef as Ref<HTMLInputElement>}
        id={id}
        type="text"
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={ro}
      />
    </div>
  );
}
