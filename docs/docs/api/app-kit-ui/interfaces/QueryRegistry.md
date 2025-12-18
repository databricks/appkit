# Interface: QueryRegistry

Defined in: [packages/app-kit-ui/src/react/hooks/types.ts:74](https://github.com/databricks/app-kit/blob/main/packages/app-kit-ui/src/react/hooks/types.ts#L74)

Query Registry for type-safe analytics queries.
Extend this interface via module augmentation to get full type inference:

## Example

```typescript
// config/appKitTypes.d.ts
declare module "@databricks/app-kit-ui/react" {
  interface QueryRegistry {
    apps_list: {
      name: "apps_list";
      parameters: { startDate: string; endDate: string; aggregationLevel: string };
      result: Array<{ id: string; name: string }>;
    };
  }
}
```

## Indexable

```ts
[key: string]: object
```
