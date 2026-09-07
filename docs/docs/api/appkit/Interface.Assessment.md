# Interface: Assessment

A Feedback assessment in the MLflow REST proto-JSON shape.

## Properties

### assessment\_name

```ts
assessment_name: string;
```

***

### feedback

```ts
feedback: {
  value: unknown;
};
```

#### value

```ts
value: unknown;
```

***

### metadata?

```ts
optional metadata: Record<string, string>;
```

***

### rationale?

```ts
optional rationale: string;
```

***

### source

```ts
source: {
  source_id: string;
  source_type: "CODE" | "HUMAN" | "LLM_JUDGE";
};
```

#### source\_id

```ts
source_id: string;
```

#### source\_type

```ts
source_type: "CODE" | "HUMAN" | "LLM_JUDGE";
```

***

### trace\_id

```ts
trace_id: string;
```
