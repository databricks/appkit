---
sidebar_position: 6
---

# Lakeflow Designer

<!-- AUTO-GENERATED: stability-banner-start -->
:::warning Beta plugin
This plugin is currently **beta**. APIs may change between minor releases. Import from `@databricks/appkit/beta`. See [Plugin Stability Tiers](./stability.md).
:::
<!-- AUTO-GENERATED: stability-banner-end -->

The beta `designer()` plugin runs the backend of a published Lakeflow Designer App. It serves the publisher's manifest, submits and monitors its runner Job, decodes notebook results, and transfers uploaded and generated files. The template owns the React interface, charts, tables, HTML sandbox, and browser recovery.

```typescript
import { createApp, server } from "@databricks/appkit";
import { designer } from "@databricks/appkit/beta";

await createApp({ plugins: [server(), designer()] });
```

The Designer publisher provisions the Job and resource permissions. Register this plugin in that published template; it does not create a flow or grant permissions. No generic Jobs or Files plugins are required.

## Runtime contract

The plugin preserves the Designer template's `/api/designer` API and manifest version 8:

| Endpoint | Behavior |
| --- | --- |
| `GET /config` | Read the current manifest and check whether its runner is ready |
| `POST /run` | Validate inputs and submit the bound Job |
| `GET /run/:jobRunId` | Read an authorized run and its output blocks |
| `DELETE /run/:jobRunId` | Cancel an authorized run |
| `GET /last-run`, `GET /runs` | Read the viewer's active run and history |
| `POST /uploads/:parameterName` | Stream an immutable parameter upload |
| `GET /uploads/:parameterName/:reference/download` | Download an owned upload |
| `GET /run/:jobRunId/files/:outputId/:fileIndex/download` | Download a declared file from an authorized run |

All paths in the table are relative to `/api/designer`. File uploads use `application/octet-stream` with the URL-encoded filename in `X-File-Name`. Run submissions use JSON `{ params: { ... } }`.

`DATABRICKS_JOB_ID` identifies the publisher-owned Job. The plugin discovers `designerApp.json` beside its runner notebook; the manifest is outside the publicly served app assets. Missing or incompatible manifests make the App unrunnable. Republish refreshes the manifest without requiring a redeploy. Submission remains unavailable while the manifest and runner revision disagree.

`DATABRICKS_APP_ID`, falling back to `DATABRICKS_CLIENT_ID`, identifies the App in run attribution. Databricks Apps ingress supplies the trusted `X-Forwarded-User` and email headers. Jobs, workspace reads, and file storage use the App service principal. An optional forwarded access token is used only to look up the submitting user's display name. A custom deployment must provide an equally trusted ingress; these headers are not credentials supplied by an end user.

The Job resource retains the publisher's `CAN_MANAGE` permission. Optional upload and output volumes come from the validated manifest, including changes made by republishing. Their grants remain the publisher's responsibility; a plugin manifest cannot discover these resources synchronously. Storage uses the Files connector directly, without nested AppKit instances, volume environment mutations, or generic `/api/files` routes.

Every run read, cancellation, and download checks Job and viewer ownership. Download checks also validate the current publication, output declaration, and recorded receipt. Origin checks and private response headers apply throughout. Completed-output caches belong to the plugin instance and are cleared on shutdown; authorization precedes cache reads. Disabled nodes and groups use existing exported notebook metadata and manifest hints, without a codegen change.

## Browser contracts

Import schemas, types, and browser helpers through the dedicated entry point:

```typescript
import {
  appManifestSchema,
  type AppManifest,
  fileDownloadRoute,
} from "@databricks/appkit/beta/designer";
```

This entry contains no server code or Node built-ins. Do not import the server plugin from a browser entry. Like `designer()`, these contracts are beta and should be consumed from an exact AppKit version.

## Iterate locally with the Designer template

Start from a template whose server uses the bootstrap above and whose shared imports use `@databricks/appkit/beta/designer`. In an AppKit checkout, install dependencies and build once:

```bash
pnpm install --frozen-lockfile
pnpm build
```

In the template checkout, link the package:

```bash
APPKIT_DIR=/absolute/path/to/appkit
pnpm link "$APPKIT_DIR/packages/appkit"
```

Run the template with the development export condition and explicit watches for linked sources:

```bash
NODE_ENV=development NODE_OPTIONS=--conditions=development \
  DISABLE_REMOTE_SERVING=true pnpm exec tsx watch \
  --include "$APPKIT_DIR/packages/appkit/src/**/*.ts" \
  --include "$APPKIT_DIR/packages/shared/src/**/*.ts" \
  --tsconfig ./tsconfig.server.json --env-file-if-exists=./.env \
  ./server/server.ts
```

`NODE_ENV` alone does not select Node's `development` exports. Plugin and shared-source edits restart the server; Vite continues to provide client HMR. Configure the usual local Databricks credentials and a test runner Job in `.env`. Use `APPKIT_DEV_OBO=false` only if your local CLI does not support AppKit's development OBO token flow.

Run backend tests from the AppKit checkout:

```bash
pnpm exec vitest run --project appkit src/plugins/designer
```

These tests boot the real AppKit server with simulated Databricks services. They cover submission, ownership, history, streaming files, manifest refresh, output decoding, and shutdown isolation. They do not replace a Databricks deployment test.

After local work, restore the template's pinned registry dependency and lockfile. Do not commit the local link or its pnpm override.

## Test the packaged integration before release

From AppKit, build and package the SDK through its normal distribution process:

```bash
pnpm build
pnpm docs:build
pnpm --filter @databricks/appkit tarball
```

The tarball is written under `packages/appkit/tmp/`. In a separate test template branch, copy it into the template and install it:

```bash
mkdir -p vendor
cp "$APPKIT_DIR"/packages/appkit/tmp/databricks-appkit-*.tgz vendor/
pnpm add ./vendor/databricks-appkit-<version>.tgz
pnpm build
```

Remove the `overrides["@databricks/appkit"]` source-link entry in `pnpm-workspace.yaml` first. Commit the test template, tarball, and generated pnpm lockfile together. This makes the cloud build consume the same package you tested locally, including its compiled exports and bundled shared code. Keep existing template dependency overrides and patches in place.

Publish a separate test App from that template commit using the Designer environment's template-reference override. Verify the deployment build log resolves the tarball, then exercise:

1. Manifest loading and an enabled Run button.
2. A successful run with table, chart, and HTML output.
3. Both parameter-controlled branches, including disabled groups.
4. Upload, run, and repeated input/output downloads.
5. History selection, cancellation, and access from a second viewer.
6. Republish with changed inputs or storage, followed by a fresh run.

The test tarball and template-reference override are for validation. The production sequence is: merge the AppKit PR, release AppKit, update the template's exact dependency and lockfile, advance the publisher's template revision, and redeploy Apps that need the new server. Do not pin an unpublished registry version or ship a local filesystem link.
