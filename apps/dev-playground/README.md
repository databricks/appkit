# Dev Playground

Test application showing AppKit capabilities including analytics dashboards, SSE streaming, telemetry, and data visualization.

## Development

```bash
# Start development server
pnpm dev

# Build for production
pnpm build

# Start production server
pnpm start:local
```

## Integration Tests

Integration tests use Playwright to verify the application works correctly with mocked backend responses.

**Note:** These are frontend-only integration tests. API calls are intercepted at the browser level and return mock data, so the AppKit backend plugins are not tested. They focus on verifying UI behavior, navigation, data rendering, and client-side interactions.

### Running Tests

```bash
# Run all integration tests
pnpm test:integration

# Run tests with interactive UI mode (for debugging)
pnpm test:integration:ui

# Run tests in headed mode (see the browser)
pnpm test:integration:headed

# Run a specific test file
npx playwright test tests/smoke.spec.ts

# Run tests matching a pattern
npx playwright test -g "analytics"
```
