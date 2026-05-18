# Interface: ToolkitOptions

## Properties

### except?

```ts
optional except: string[];
```

Exclude tools whose local name matches one of these.

***

### only?

```ts
optional only: string[];
```

Only include tools whose local name matches one of these.

***

### prefix?

```ts
optional prefix: string;
```

Key prefix to prepend to each tool's local name. Defaults to `${pluginName}.`.

***

### rename?

```ts
optional rename: Record<string, string>;
```

Remap specific local names to different keys (applied after prefix).
