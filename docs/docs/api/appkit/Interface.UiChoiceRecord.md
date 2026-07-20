# Interface: UiChoiceRecord

One recorded variant choice.

CONTRACT: the `databricks-app-variants` agent skill parses these fields
(`blockId`, `chosenIndex`, `label`) to finalize the chosen variant. Renaming
or removing a field silently breaks finalization (the skill reads it from the
JSONL line, so there's no compile error) — update the skill in the same
change.

## Properties

### blockId

```ts
blockId: string;
```

Stable id of the `<Variants>` block the developer confirmed.

***

### chosenIndex

```ts
chosenIndex: number;
```

Zero-based index of the chosen `<Variant>` child.

***

### label?

```ts
optional label: string;
```

Human-readable label of the chosen variant (for agent context).

***

### note?

```ts
optional note: string;
```

Optional free-form note from the developer.

***

### ts

```ts
ts: string;
```

ISO timestamp of when the choice was recorded.
