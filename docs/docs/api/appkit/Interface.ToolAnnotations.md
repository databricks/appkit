# Interface: ToolAnnotations

## Properties

### ~~destructive?~~

```ts
optional destructive: boolean;
```

#### Deprecated

Prefer [effect](#effect) with value `"destructive"`. Retained
so existing annotations continue to force the approval gate, and so
MCP-style consumers that only read `destructive` still see the hint.

***

### effect?

```ts
optional effect: ToolEffect;
```

Preferred semantic label. When set, drives both the approval gate (fires
for `write`/`update`/`destructive`) and the approval-card styling.

***

### idempotent?

```ts
optional idempotent: boolean;
```

***

### ~~readOnly?~~

```ts
optional readOnly: boolean;
```

#### Deprecated

Prefer [effect](#effect). Retained for backward compatibility
with tools authored against the original flags and for MCP interop.

***

### requiresUserContext?

```ts
optional requiresUserContext: boolean;
```
