# Interface: RegisteredAgent

## Properties

### adapter

```ts
adapter: AgentAdapter;
```

***

### baseSystemPrompt?

```ts
optional baseSystemPrompt: BaseSystemPromptOption;
```

***

### ephemeral?

```ts
optional ephemeral: boolean;
```

Mirrors `AgentDefinition.ephemeral` — skip thread persistence.

***

### generationParams?

```ts
optional generationParams: GenerationParams;
```

Mirrors `AgentDefinition.generationParams`.

***

### instructions

```ts
instructions: string;
```

***

### maxSteps?

```ts
optional maxSteps: number;
```

***

### maxTokens?

```ts
optional maxTokens: number;
```

***

### name

```ts
name: string;
```

***

### toolIndex

```ts
toolIndex: Map<string, ResolvedToolEntry>;
```
