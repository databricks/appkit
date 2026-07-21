# Interface: GenerationParams

Optional generation parameters forwarded to the OpenAI-compatible serving
request body. Names match the serving API wire keys. Only keys that are set
are sent — undefined values are omitted so the endpoint applies its own
defaults. Ranges are not validated here; the serving endpoint validates.

## Properties

### frequency\_penalty?

```ts
optional frequency_penalty: number;
```

Penalize tokens by frequency.

***

### presence\_penalty?

```ts
optional presence_penalty: number;
```

Penalize tokens by prior presence.

***

### stop?

```ts
optional stop: string | string[];
```

Stop sequence(s) that end generation.

***

### temperature?

```ts
optional temperature: number;
```

Sampling temperature.

***

### top\_p?

```ts
optional top_p: number;
```

Nucleus sampling probability mass (`top_p`).
