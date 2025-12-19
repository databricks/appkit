# Function: ChartWrapper()

```ts
function ChartWrapper(props): Element;
```

Defined in: [packages/appkit-ui/src/react/charts/wrapper.tsx:157](https://github.com/databricks/appkit/blob/main/packages/appkit-ui/src/react/charts/wrapper.tsx#L157)

Wrapper component for charts.
Handles data fetching (query mode) or direct data injection (data mode).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `props` | [`ChartWrapperProps`](../type-aliases/ChartWrapperProps.md) |

## Returns

`Element`

## Examples

```tsx
<ChartWrapper
  queryKey="spend_data"
  parameters={{ limit: 100 }}
  format="auto"
>
  {(data) => <MyChart data={data} />}
</ChartWrapper>
```

```tsx
<ChartWrapper data={myArrowTable}>
  {(data) => <MyChart data={data} />}
</ChartWrapper>
```
