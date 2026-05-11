# Interface: AutoInheritToolsConfig

Auto-inherit configuration. When enabled for a given agent origin, agents
with no explicit `tools:` declaration receive every registered ToolProvider
plugin tool whose author marked `autoInheritable: true`. Tools without that
flag — destructive, state-mutating, or privilege-sensitive — never spread
automatically and must be wired via `tools:` (object or function form in
code, `plugin:NAME` entries in markdown frontmatter).

Defaults are `false` for both origins (safe-by-default): developers must
consciously opt an origin in to any auto-inherit behaviour.

## Properties

### code?

```ts
optional code: boolean;
```

Default for code-defined agents (via `agents: { foo: createAgent(...) }`). Default: `false`.

***

### file?

```ts
optional file: boolean;
```

Default for agents loaded from markdown files. Default: `false`.
