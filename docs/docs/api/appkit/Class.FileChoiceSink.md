# Class: FileChoiceSink

Default [ChoiceSink](Interface.ChoiceSink.md): upserts choices into UI\_CHOICES\_FILE,
one line per `<Variants>` id.

The file is resolved against `process.cwd()`, so it lands under whatever
directory the dev server runs from. Concurrent confirms are serialized behind
an internal queue so their read-modify-write can't interleave and lose an
update.

## Implements

- [`ChoiceSink`](Interface.ChoiceSink.md)

## Constructors

### Constructor

```ts
new FileChoiceSink(relativePath: string): FileChoiceSink;
```

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `relativePath` | `string` | `UI_CHOICES_FILE` |

#### Returns

`FileChoiceSink`

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

#### Implementation of

[`ChoiceSink`](Interface.ChoiceSink.md).[`record`](Interface.ChoiceSink.md#record)
