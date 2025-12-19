---
sidebar_position: 1
---

# Getting Started

AppKit is a TypeScript SDK for building production-ready Databricks applications with a plugin-based architecture. It provides opinionated defaults, built-in observability, and seamless integration with Databricks services.

## Introduction

AppKit simplifies building data applications on Databricks by providing:

- **Plugin Architecture**: Modular design with built-in server and analytics plugins
- **Type Safety**: End-to-end TypeScript with automatic query type generation
- **Production Ready**: Built-in caching, telemetry, retry logic, and error handling
- **Developer Experience**: Hot reload, file-based queries, and AI-assisted development
- **Databricks Native**: Seamless integration with SQL Warehouses, Unity Catalog, and workspace resources

## Installation

### Prerequisites

Install Node.js using [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install --lts
```

Install pnpm:

```bash
npm install --global corepack@latest
corepack enable pnpm
```

### Install Packages

```bash
pnpm add @databricks/appkit @databricks/appkit-ui
```

For React applications, also install peer dependencies:

```bash
pnpm add react react-dom
```

## Quick Start

Create a minimal server application:

```typescript
// server.ts
import { createApp, server } from "@databricks/appkit";

createApp({
  plugins: [server()],
});
```

Run the application:

```bash
pnpm tsx server.ts
```

Your app is now running at `http://localhost:8000`.

### Adding Analytics

Add SQL query capabilities:

```typescript
// server.ts
import { createApp, server, analytics } from "@databricks/appkit";

createApp({
  plugins: [
    server(),
    analytics(),
  ],
});
```

Create a query file:

```sql
-- config/queries/users.sql
SELECT * FROM main.default.users WHERE created_at > :startDate;
```

Query from your frontend using the React hook:

```typescript
// App.tsx
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";

function UsersList() {
  const { data, loading, error } = useAnalyticsQuery({
    queryKey: "users",
    parameters: { startDate: "2024-01-01" },
  });

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <ul>
      {data?.map((user) => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  );
}
```

## Next Steps

- **[Core Concepts](./core-concepts/principles)**: Learn about AppKit's design principles and architecture
- **[Development](./development)**: Set up your development environment with hot reload and type generation
- **[Deployment](./deployment)**: Deploy your application to Databricks
- **[API Reference](./api/appkit/)**: Explore the complete API documentation
