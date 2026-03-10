# Interface: InvokeParams

Agent interface types for the AppKit Agent Plugin.

These types define the contract between the plugin framework and agent
implementations. They mirror the OpenAI Responses API SSE format without
requiring the `openai` package as a dependency.

## Properties

### chat\_history?

```ts
optional chat_history: {
  content: string;
  role: string;
}[];
```

#### content

```ts
content: string;
```

#### role

```ts
role: string;
```

***

### input

```ts
input: string;
```
