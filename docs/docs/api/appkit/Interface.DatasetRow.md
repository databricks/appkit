# Interface: DatasetRow

One row of a managed evaluation dataset. `inputs` are the kwargs passed to the
agent for the turn; `expectations` (when present) is the row's ground truth /
guidelines. Mirrors the `{inputs, expectations}` shape of `mlflow.genai`
datasets and of the Unity Catalog table backing a managed eval dataset.

## Properties

### expectations?

```ts
optional expectations: Record<string, unknown>;
```

***

### inputs

```ts
inputs: Record<string, unknown>;
```
