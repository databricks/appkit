---
sidebar_position: 4
---

# Deployment

Deploy your App Kit application to Databricks to run in production with access to workspace resources, Unity Catalog, and SQL Warehouses.

## Prerequisites

### Databricks CLI

Ensure the Databricks CLI is installed:

```bash
# macOS
brew install databricks/tap/databricks

# Linux/Windows
curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh
```

Verify installation:

```bash
databricks --version
```

See the [official installation guide](https://docs.databricks.com/dev-tools/cli/install.html) for more details.

### Workspace Access

You need:
- Access to a Databricks workspace
- Permissions to create and deploy apps
- Access to a SQL Warehouse (for analytics queries)

### Authentication

Configure authentication before deploying:

```bash
# Interactive configuration
databricks configure --profile production

# Or use environment variables
export DATABRICKS_HOST="https://your-workspace.cloud.databricks.com"
export DATABRICKS_TOKEN="your-personal-access-token"
```

## App Configuration

### Create app.yaml

Create an `app.yaml` file in your project root to configure your application:

```yaml
# app.yaml
env:
  - name: DATABRICKS_WAREHOUSE_ID
    valueFrom: sql-warehouse
```

**Configuration Options:**

```yaml
# Full example with all options
env:
  # SQL Warehouse for analytics queries
  - name: DATABRICKS_WAREHOUSE_ID
    valueFrom: sql-warehouse
  
  # Custom environment variables
  - name: API_KEY
    value: "your-api-key"
  
  # Reference workspace secrets
  - name: DATABASE_PASSWORD
    valueFrom:
      secret:
        scope: my-scope
        key: db-password
```

### Environment Variables

Common environment variables for App Kit applications:

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABRICKS_WAREHOUSE_ID` | SQL Warehouse ID for queries | Yes (if using analytics) |
| `DATABRICKS_APP_PORT` | Server port (default: 8000) | No |
| `NODE_ENV` | Environment mode | No |

## Deployment Steps

### 1. Build Your Application

Build the production bundle:

```bash
pnpm build
```

This creates optimized static files in the `dist/` directory.

### 2. Sync Code to Workspace

Sync your application code to the Databricks workspace:

```bash
databricks sync --watch . /Workspace/Users/your-email@company.com/databricks_apps/my-app
```

**Options:**
- `--watch`: Continuously sync changes (useful during development)
- `.`: Source directory (current directory)
- `/Workspace/Users/.../my-app`: Destination path in workspace

**Without Watch Mode:**

```bash
databricks sync . /Workspace/Users/your-email@company.com/databricks_apps/my-app
```

### 3. Deploy the Application

Deploy your application:

```bash
databricks apps deploy my-app \
  --source-code-path /Workspace/Users/your-email@company.com/databricks_apps/my-app
```

**Deployment Process:**
1. Validates `app.yaml` configuration
2. Packages application code
3. Creates or updates the app in Databricks
4. Starts the application server
5. Provisions resources (SQL Warehouse access, etc.)

### 4. Verify Deployment

Check the deployment status:

```bash
databricks apps list
```

Get detailed app information:

```bash
databricks apps get my-app
```

View application logs:

```bash
databricks apps logs my-app
```

## Deployment Workflow

### Complete Deployment Script

Create a deployment script for convenience:

```bash
#!/bin/bash
# deploy.sh

set -e

APP_NAME="my-app"
WORKSPACE_DIR="/Workspace/Users/$(databricks current-user me | jq -r .userName)/databricks_apps/${APP_NAME}"

echo "Building application..."
pnpm build

echo "Syncing to workspace..."
databricks sync . "${WORKSPACE_DIR}"

echo "Deploying application..."
databricks apps deploy "${APP_NAME}" --source-code-path "${WORKSPACE_DIR}"

echo "Deployment complete!"
echo "View logs: databricks apps logs ${APP_NAME}"
```

Make it executable:

```bash
chmod +x deploy.sh
./deploy.sh
```

### Using Environment Variables

Customize deployment with environment variables:

```bash
# Set deployment configuration
export DATABRICKS_PROFILE=production
export DATABRICKS_APP_NAME=my-app-prod
export DATABRICKS_WORKSPACE_DIR=/Workspace/Users/$(databricks current-user me --profile ${DATABRICKS_PROFILE} | jq -r .userName)/databricks_apps/${DATABRICKS_APP_NAME}

# Deploy
databricks apps deploy ${DATABRICKS_APP_NAME} \
  --source-code-path ${DATABRICKS_WORKSPACE_DIR} \
  --profile ${DATABRICKS_PROFILE}
```

## Managing Deployments

### Update Existing App

To update a deployed application, simply redeploy:

```bash
# Sync latest changes
databricks sync . /Workspace/Users/your-email@company.com/databricks_apps/my-app

# Redeploy
databricks apps deploy my-app \
  --source-code-path /Workspace/Users/your-email@company.com/databricks_apps/my-app
```

### View Application Logs

Stream logs in real-time:

```bash
databricks apps logs my-app --follow
```

View recent logs:

```bash
databricks apps logs my-app --tail 100
```

### Stop Application

Stop a running application:

```bash
databricks apps stop my-app
```

### Start Application

Start a stopped application:

```bash
databricks apps start my-app
```

### Delete Application

Remove an application completely:

```bash
databricks apps delete my-app
```

## Best Practices

### Pre-Deployment Checklist

Before deploying to production:

- ✅ Test locally with production-like data
- ✅ Run `pnpm build` to verify build succeeds
- ✅ Review `app.yaml` configuration
- ✅ Verify SQL Warehouse access
- ✅ Check environment variables are set
- ✅ Test authentication and permissions
- ✅ Review application logs for errors

### Configuration Management

**Use Workspace Environment Variables:**

Instead of hardcoding values in `app.yaml`, use workspace environment variables:

```yaml
env:
  - name: API_KEY
    valueFrom:
      secret:
        scope: production
        key: api-key
```

**Separate Environments:**

Use different app names for different environments:

```bash
# Development
databricks apps deploy my-app-dev --source-code-path /Workspace/.../my-app-dev

# Staging
databricks apps deploy my-app-staging --source-code-path /Workspace/.../my-app-staging

# Production
databricks apps deploy my-app-prod --source-code-path /Workspace/.../my-app-prod
```

### Security

**Protect Sensitive Data:**

- Never commit secrets to version control
- Use Databricks secrets for sensitive values
- Rotate credentials regularly
- Use least-privilege access for SQL Warehouses

**Example with Secrets:**

```yaml
env:
  - name: DATABASE_URL
    valueFrom:
      secret:
        scope: production
        key: database-url
  
  - name: API_SECRET
    valueFrom:
      secret:
        scope: production
        key: api-secret
```

### Monitoring

**Enable Telemetry:**

Configure telemetry in your application:

```typescript
// server.ts
import { createApp, server, analytics } from "@databricks/app-kit";

await createApp({
  plugins: [server(), analytics()],
  telemetry: {
    traces: true,
    metrics: true,
    logs: true,
  },
});
```

**Monitor Application Health:**

Regularly check:
- Application logs for errors
- Query performance metrics
- Cache hit rates
- API response times

### Performance

**Optimize for Production:**

1. **Enable Caching:**
```typescript
await createApp({
  plugins: [server(), analytics()],
  cache: {
    enabled: true,
    ttl: 3600, // 1 hour
  },
});
```

2. **Use Arrow Format for Large Datasets:**
```typescript
const { data } = useAnalyticsQuery({
  queryKey: "large_dataset",
  format: "ARROW", // More efficient than JSON
});
```

3. **Configure Appropriate Timeouts:**
```typescript
analytics({
  timeout: 30000, // 30 seconds
})
```

### Rollback Strategy

If deployment issues occur:

1. **Quick Rollback:**
```bash
# Redeploy previous version
databricks sync ./previous-version /Workspace/.../my-app
databricks apps deploy my-app --source-code-path /Workspace/.../my-app
```

2. **Use Version Control:**
```bash
# Tag releases
git tag v1.0.0
git push origin v1.0.0

# Rollback to previous tag
git checkout v1.0.0
./deploy.sh
```

## Troubleshooting

### Common Issues

**Deployment Fails:**

```bash
# Check app status
databricks apps get my-app

# View detailed logs
databricks apps logs my-app --tail 200
```

**SQL Warehouse Not Found:**

Verify warehouse ID:
```bash
databricks warehouses list
```

Update `app.yaml` with correct warehouse ID.

**Permission Denied:**

Ensure you have:
- App creation permissions in workspace
- Access to the specified SQL Warehouse
- Read access to referenced secrets

**Application Won't Start:**

Check logs for errors:
```bash
databricks apps logs my-app --follow
```

Common causes:
- Missing environment variables
- Invalid `app.yaml` configuration
- Build artifacts not included in sync
- Port conflicts

### Getting Help

- **CLI Help:** `databricks apps deploy --help`
- **Databricks Documentation:** [https://docs.databricks.com/dev-tools/cli/](https://docs.databricks.com/dev-tools/cli/)
- **App Kit Issues:** [GitHub Issues](https://github.com/databricks/app-kit/issues)

## Next Steps

- **[Development](./development)**: Set up remote tunneling for debugging deployed apps
- **[Architecture](./core-concepts/architecture)**: Understand how App Kit works in production
- **[Monitoring](./core-concepts/architecture#observability)**: Learn about built-in telemetry and observability
