# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About This Repository

Databricks AppKit is a modular TypeScript SDK for building Databricks applications with a plugin-based architecture. This is a **pnpm monorepo** using **Turbo** for build orchestration.

**AI/Code Assistant Resources:**
- See [llms.txt](./llms.txt) for full SDK usage guidance and anti-patterns
- See [llms-compact.txt](./llms-compact.txt) for quick usage patterns

## Repository Structure

```
/packages/
  /appkit/          - Core SDK with plugin architecture
  /appkit-ui/       - React components and JS utilities
  /shared/           - Shared TypeScript types across packages

/apps/
  /dev-playground/   - Reference application
    /server/         - Node.js backend with AppKit
    /client/         - React frontend (Vite + React 19)

/tools/
  - setup.sh         - Initial repository setup
  - deploy-playground.ts - Deploy to Databricks workspace
```

## Development Commands

### Initial Setup
```bash
npm install --global corepack@latest
corepack enable pnpm
pnpm setup:repo
```

After setup, configure `.env` in `apps/dev-playground/server/.env`:
```
DATABRICKS_HOST=your-workspace-url
```

### Development Workflow
```bash
pnpm dev              # Build all packages + watch mode (sets NODE_ENV=development)
pnpm dev:inspect      # Dev mode with Node.js inspector for debugging

# Individual package commands (from root)
pnpm --filter=dev-playground dev     # Run only dev-playground in watch mode
```

### Building
```bash
pnpm build            # Build all packages (runs pnpm -r build:package)
pnpm build:watch      # Watch mode for all packages except dev-playground
pnpm pack:sdk         # Build and package SDK for distribution
```

### Production
```bash
pnpm start            # Build everything and run dev-playground in production mode
```

### Testing
```bash
pnpm test             # Run tests with coverage (vitest)
pnpm test:watch       # Run tests in watch mode
```

**Test Projects:**
- `appkit-ui`: Uses jsdom environment (for React components)
- `appkit`: Uses node environment (for Node.js SDK)

### Code Quality
```bash
pnpm lint             # Lint with Biome
pnpm lint:fix         # Lint and auto-fix
pnpm format           # Format with Biome
pnpm format:check     # Check formatting
pnpm check            # Run Biome check (lint + format)
pnpm check:fix        # Auto-fix with Biome
pnpm typecheck        # TypeScript type checking across all packages
```

### Deployment
```bash
pnpm pack:sdk                      # Package SDK for deployment
pnpm deploy:playground             # Deploy dev-playground to Databricks

# Environment variables for deployment:
export DATABRICKS_PROFILE=your-profile              # CLI profile name
export DATABRICKS_APP_NAME=your-app-name            # App name (prefixed with username if not provided)
export DATABRICKS_WORKSPACE_DIR=your-workspace-dir  # Workspace directory path
```

### Cleanup
```bash
pnpm clean            # Remove build artifacts
pnpm clean:full       # Remove build artifacts + node_modules
```

### Releasing

This project uses [release-it](https://github.com/release-it/release-it) with [conventional-changelog](https://www.conventionalcommits.org/) for automated releases. Both packages (`appkit` and `appkit-ui`) are always released together with the same version.

#### GitHub Actions (Recommended)

Releases are automated via GitHub Actions and trigger in two ways:

**Automatic (on merge to main):**
- When PRs are merged to `main`, the workflow automatically runs
- Analyzes commits since last release using conventional commits
- If there are `feat:` or `fix:` commits, both packages are released together
- If no releasable commits, the release is skipped

**Manual (workflow_dispatch):**
1. Go to **Actions → Release → Run workflow**
2. Optionally enable "Dry run" to preview without publishing
3. Click "Run workflow"

**Permissions (already configured, no secrets needed):**
- `contents: write` - to push commits and tags
- `id-token: write` - for npm OIDC/provenance publishing

Both `GITHUB_TOKEN` and npm OIDC are provided automatically by GitHub Actions.

The workflow automatically:
- Builds all packages
- Bumps version based on conventional commits
- Updates `CHANGELOG.md`
- Creates git tag and GitHub release
- Publishes to npm

#### Local Release (Alternative)

**Prerequisites:**
- Be on `main` branch with a clean working directory
- Set `GITHUB_TOKEN` environment variable
- Be logged in to npm (`npm login`)

```bash
# Dry run (preview what will happen without making changes)
pnpm release:dry

# Interactive release (prompts for version bump)
pnpm release

# CI release (non-interactive, for automation)
pnpm release:ci
```

#### Version Bumps (Conventional Commits)

- `feat:` → Minor version bump (0.1.0 → 0.2.0)
- `fix:` → Patch version bump (0.1.0 → 0.1.1)
- `feat!:` or `BREAKING CHANGE:` → Major version bump (0.1.0 → 1.0.0)

## Architecture Overview

### Plugin System

AppKit uses a **phase-based plugin architecture** with three initialization phases:

1. **core** - Initialized first (e.g., config plugins)
2. **normal** - Initialized second (most plugins)
3. **deferred** - Initialized third, receives other plugin instances (e.g., ServerPlugin)

**Creating a Plugin:**
```typescript
import { Plugin, toPlugin } from '@databricks/appkit';

class MyPlugin extends Plugin {
  name: string = "my-plugin";

  // Validate required environment variables
  validateEnv() {
    // Check process.env for required vars
  }

  // Async initialization
  async setup() {
    // Initialize resources
  }

  // Register HTTP routes (optional)
  injectRoutes(router: express.Router) {
    // Routes are automatically scoped to /api/{plugin-name}
    router.get("/endpoint", async (req, res) => {
      // Use this.execute() for interceptor support
      const result = await this.execute(() => fetchData(), {
        cache: { ttl: 60000 },
        retry: { maxRetries: 3 }
      });
      res.json(result);
    });
  }
}

export const myPlugin = toPlugin<typeof MyPlugin, MyPluginConfig, "myPlugin">(
  MyPlugin,
  "myPlugin"
);
```

### Execution Interceptor Pattern

Plugins use `execute()` or `executeStream()` which apply interceptors in this order:
1. **TelemetryInterceptor** (outermost) - Traces execution span
2. **TimeoutInterceptor** - AbortSignal timeout
3. **RetryInterceptor** - Exponential backoff retry
4. **CacheInterceptor** (innermost) - TTL-based caching

Example:
```typescript
await this.execute(
  () => expensiveOperation(),
  {
    cache: { ttl: 60000 },        // Cache for 60 seconds
    retry: { maxRetries: 3 },      // Retry up to 3 times
    timeout: 5000,                 // 5 second timeout
    telemetry: { traces: true }    // Enable tracing
  }
);
```

### Server-Sent Events (SSE) Streaming

The SDK has built-in SSE support with automatic reconnection:

**Key Features:**
- Connection ID-based stream tracking
- Event ring buffer for missed event replay (reconnection)
- Per-stream abort signals for cancellation
- Automatic heartbeat to keep connections alive

**StreamManager** handles:
- New stream creation with AsyncGenerator handler
- Client reconnection with Last-Event-ID header
- Graceful error handling and cleanup

### Telemetry (OpenTelemetry)

**TelemetryManager** (singleton):
- Initializes tracer, meter, logger providers
- Auto-instrumentations for Node.js, Express, HTTP
- Exports to OTEL_EXPORTER_OTLP_ENDPOINT (if configured)

**TelemetryProvider** (per-plugin):
- Plugin name as default tracer/meter scope
- Supports traces, metrics, logs (configurable per plugin)

### Analytics Query Pattern

The AnalyticsPlugin provides SQL query execution:
- Queries stored in `config/queries/`
- Query file naming determines execution context:
  - `<query_key>.sql` - Executes as service principal (shared cache)
  - `<query_key>.obo.sql` - Executes as user (OBO = On-Behalf-Of, per-user cache)
- All queries should be parameterized (use placeholders)
- POST `/api/analytics/query/:query_key` - Execute query with parameters
- Built-in caching with configurable TTL
- Databricks SQL Warehouse connector for execution

### Frontend-Backend Interaction

```
React Client (Vite)
  ↓ HTTP POST / SSE
Express Server
  ↓ Routes: /api/{plugin-name}/{endpoint}
Plugin.injectRoutes()
  ↓ this.execute() with interceptors
Databricks Services (SQL Warehouse, APIs)
```

**Dev Mode:**
- Vite dev server with HMR
- Hot-reload for backend code with tsx watch

**Production Mode:**
- Static file serving from `client/dist`
- Compiled server bundle

## Build System

### Bundler: tsdown

**tsdown** is used for fast TypeScript bundling with tree-shaking:
- **unbundle mode** - Preserves module structure (faster builds, better tree-shaking)
- **Shared package bundled inline** - `shared` package is bundled with noExternal
- **npm dependencies external** - Keeps bundle size small
- **Generates .d.ts** - Type definitions with proper resolution

### Frontend: Vite (rolldown-vite fork)

The frontend uses `rolldown-vite@7.1.14`, a performance-optimized Vite fork.

**Key plugins:**
- `@vitejs/plugin-react` - React Fast Refresh
- `@tanstack/router-plugin` - File-based routing with auto code-splitting

### Formatter/Linter: Biome

Biome is used instead of ESLint/Prettier for faster performance:
- Lint-staged integration via husky
- Configured in `biome.json` (if present)

## Working with the Monorepo

### Adding Dependencies

```bash
# Root dependencies (dev tools)
pnpm add -Dw <package>

# Package-specific dependencies
pnpm --filter=@databricks/appkit add <package>

# App dependencies
pnpm --filter=dev-playground add <package>
```

### Creating New Packages

Packages should:
1. Be added to `packages/` directory
2. Have a `package.json` with workspace protocol dependencies: `"@databricks/shared": "workspace:*"`
3. Extend root `tsconfig.json`
4. Include `build:package` and `build:watch` scripts

### Type Generation

`packages/appkit/src/utils/type-generator.ts` creates plugin registry types at build time. This enables:
```typescript
const AppKit = await createApp({ plugins: [...] });
AppKit.myPlugin.method();  // Typed based on registered plugins
```

## Dev-Playground App Structure

The reference app demonstrates AppKit usage:

**Backend (`apps/dev-playground/server/`):**
- `index.ts` - Creates AppKit with server, analytics, and custom plugins
- `reconnect-plugin.ts` - Example plugin with SSE reconnection
- `telemetry-example-plugin.ts` - Example plugin with telemetry

**Frontend (`apps/dev-playground/client/`):**
- Vite + React 19 + TypeScript
- TanStack Router for file-based routing (routes in `src/routes/`)
- Components from `@databricks/appkit-ui`
- Route files: `src/routes/<page-name>.route.tsx`
- Root layout: `src/routes/__root.tsx`

**Adding a New Page:**
1. Create `src/routes/<page-name>.route.tsx`
2. Add navigation link in `__root.tsx`
3. Route tree regenerates automatically on build

## Environment Configuration

**Required for dev-playground:**
```env
DATABRICKS_HOST=https://your-workspace.cloud.databricks.com
DATABRICKS_WAREHOUSE_ID=your-warehouse-id  # Optional, for analytics
```

**Optional telemetry:**
```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318  # OpenTelemetry collector
```

## Commit Conventions

**Developer Certificate of Origin (DCO):**
All commits must be signed off with:
```bash
git commit -s -m "Your commit message"
```

This certifies you have the right to contribute under the open source license.

**Commit Format:**
This project uses conventional commits (enforced by commitlint):
- `feat:` - New feature
- `fix:` - Bug fix
- `chore:` - Maintenance
- `docs:` - Documentation
- `refactor:` - Code refactoring
- `test:` - Test changes

## Important Context

### Current Branch: improve-bundle-size
This branch focuses on optimizing bundle size through tsdown configuration tuning.

### Key Dependencies
- `@databricks/sdk-experimental` v0.15.0+ - Databricks services SDK
- `express` - HTTP server
- `zod` - Runtime validation
- `OpenTelemetry` - Observability (traces, metrics, logs)

### Design Philosophy
1. **Plugin-first** - Everything is a plugin for modularity
2. **Type-safe** - Heavy TypeScript usage with runtime validation (Zod)
3. **Streaming-first** - Built-in SSE support with reconnection
4. **Observability** - OpenTelemetry integration is first-class
5. **Dev Experience** - HMR, hot-reload, source maps, inspection tools

### Graceful Shutdown
The server handles SIGTERM/SIGINT with:
- 15-second timeout
- Aborts in-flight operations
- Closes connections gracefully
