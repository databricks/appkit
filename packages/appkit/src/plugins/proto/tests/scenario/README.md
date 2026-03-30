# Proto Plugin Scenario Test: Product Catalog

End-to-end scenario test for the proto plugin using a sample Product Catalog app.

## What it tests

- Proto-style JSON serialization (snake_case field names in API responses)
- Proto binary endpoint (content-type `application/x-protobuf`)
- Typed contracts between server and client (same field names, types)
- Category filtering with correct product counts
- All products visible with correct data
- Error handling (404 for non-existent products)

## Run locally

```bash
# Start the app
npx tsx app/server.ts

# Run public test cases
TASK_CASES_PATH=public/cases.json npx playwright test tests/catalog.spec.ts

# Run private test cases (evaluation only)
TASK_CASES_PATH=private/cases.json npx playwright test tests/catalog.spec.ts
```

## Run against a deployment

```bash
APP_URL=https://your-app.databricksapps.com npx playwright test tests/catalog.spec.ts
```

## Structure

```
scenario/
  meta.json              # Task config (command, URL, timeout)
  app/
    server.ts            # Sample AppKit app with proto-style contracts
    catalog.proto        # Proto definition (for reference / codegen)
  public/
    cases.json           # 5 basic scenarios (developer verification)
  private/
    cases.json           # 8 comprehensive scenarios (evaluation)
  tests/
    catalog.spec.ts      # Playwright tests parameterized by cases
```
