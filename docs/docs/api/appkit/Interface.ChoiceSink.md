# Interface: ChoiceSink

Storage backend for confirmed variant choices, decoupled from the recorder
plugin so the destination can vary by environment. The default
[FileChoiceSink](Class.FileChoiceSink.md) writes a local JSONL file, suitable wherever the
coding agent shares the app's filesystem; an environment without a shared
filesystem can supply its own implementation (e.g. a table-backed store).

Implementations must be **keyed and latest-wins**: at most one record per
`id`, and recording an existing `id` replaces it rather than appending, so
the store always reflects the current choice for each block.

## Methods

### record()

```ts
record(record: UiChoiceRecord): Promise<void>;
```

Record (upsert) a choice, keyed by `record.id`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `record` | [`UiChoiceRecord`](Interface.UiChoiceRecord.md) |

#### Returns

`Promise`\<`void`\>
