import {
  createWorkspaceClient,
  type WorkspaceClient,
} from "../workspace-client";

/**
 * Workspace client for type generation. Dev-only overrides, in order:
 *   1. `APPKIT_DEV_PROFILE` selects a `~/.databrickscfg` profile.
 *   2. `APPKIT_DEV_HOST` + `APPKIT_DEV_TOKEN` (both non-empty) authenticate
 *      with an explicit host and bearer token (PAT auth), e.g. the App Builder
 *      preview proxy.
 * Otherwise falls back to the SDK's default auth chain. Runtime clients never
 * read these variables.
 */
export function createTypegenWorkspaceClient(): WorkspaceClient {
  const profile = process.env.APPKIT_DEV_PROFILE;
  if (profile) return createWorkspaceClient({ profile });

  const host = process.env.APPKIT_DEV_HOST;
  const token = process.env.APPKIT_DEV_TOKEN;
  if (host && token) return createWorkspaceClient({ host, token });

  return createWorkspaceClient();
}
