# Variable: server

```ts
const server: ToPlugin<typeof ServerPlugin, ServerConfig, "server">;
```

Defined in: [app-kit/src/server/index.ts:364](https://github.com/databricks/app-kit/blob/main/packages/app-kit/src/server/index.ts#L364)

Creates a server plugin instance.

Factory function for the ServerPlugin. Use this to add HTTP server capabilities
to your App Kit application.

## Param

Server configuration options

## Param

Port number (default: 8000 or DATABRICKS_APP_PORT env var)

## Param

Host address (default: 0.0.0.0 or FLASK_RUN_HOST env var)

## Param

Whether to start server automatically (default: true)

## Param

Directory containing client source code

## Param

Directory containing production build

## Returns

Plugin definition for use with createApp

## Example

```typescript
import { createApp, server } from '@databricks/app-kit';

const app = await createApp({
  plugins: [server({ port: 3000 })]
});
```
