---
sidebar_position: 1
---

# Plugins

Plugins are modular extensions that add capabilities to your AppKit application. They follow a defined lifecycle and have access to shared services like caching, telemetry, and streaming.

For complete API documentation, see the [`Plugin`](../api/appkit/Class.Plugin.md) class reference.

## Using plugins

Configure plugins when creating your AppKit instance:

```typescript
import { createApp, server, analytics, genie, files } from "@databricks/appkit";

const AppKit = await createApp({
  plugins: [
    server({ port: 8000 }),
    analytics(),
    genie(),
    files(),
  ],
});
```

For complete configuration options, see [`createApp`](../api/appkit/Function.createApp.md).

## Plugin phases

Plugins initialize in three phases:

- **Core**: Reserved for framework-level plugins. Initializes first.
- **Normal**: Default phase for application plugins. Initializes after core.
- **Deferred**: Initializes last with access to other plugin instances via `config.plugins`. Use when your plugin depends on other plugins (e.g., Server Plugin).
