# Type Alias: AgentTools

```ts
type AgentTools = {
[key: string]: AgentTool;
} & {
[key: symbol]: FromPluginMarker;
};
```

Per-agent tool record. String keys map to inline tools, toolkit entries,
hosted tools, etc. Symbol keys hold `FromPluginMarker` references produced
by `fromPlugin(factory)` spreads — these are resolved at
`AgentsPlugin.setup()` time against registered `ToolProvider` plugins.
