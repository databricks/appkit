# Interface: ServingEndpointRegistry

Registry interface for serving endpoint type generation.
Empty base — augmented by the type generator's `.d.ts` output via module augmentation.

## Indexable

```ts
[key: string]: {
  chunk: unknown;
  request: Record<string, unknown>;
  response: unknown;
}
```
