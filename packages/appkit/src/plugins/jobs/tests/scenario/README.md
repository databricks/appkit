# Jobs Plugin Scenario Test: Mock Jobs API

End-to-end scenario test for the jobs plugin using a mock Jobs API server.

## What it tests

- Job submission and run ID generation
- Run lifecycle transitions (PENDING -> RUNNING -> TERMINATED)
- Run cancellation
- Multi-task job tracking
- 404 handling for non-existent runs
- Dashboard UI rendering

## Run locally

```bash
# Start the mock server
npx tsx app/server.ts

# Run public test cases
TASK_CASES_PATH=public/cases.json npx playwright test tests/jobs.spec.ts

# Run private test cases (evaluation only)
TASK_CASES_PATH=private/cases.json npx playwright test tests/jobs.spec.ts
```

## Run against a deployment

```bash
APP_URL=https://your-app.databricksapps.com npx playwright test tests/jobs.spec.ts
```

## Structure

```
scenario/
  meta.json              # Task config (command, URL, timeout)
  app/
    server.ts            # Mock Jobs API server
  public/
    cases.json           # 4 basic scenarios (developer verification)
  private/
    cases.json           # 7 comprehensive scenarios (evaluation)
  tests/
    jobs.spec.ts         # Playwright tests parameterized by cases
```
