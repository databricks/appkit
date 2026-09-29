import {
  createWorkspaceClient,
  type WorkspaceClient,
} from "../workspace-client";

/**
 * Workspace client for type generation. `APPKIT_DEV_PROFILE` selects a
 * `~/.databrickscfg` profile for typegen only; unset falls back to the SDK's
 * default auth chain.
 */
export function createTypegenWorkspaceClient(): WorkspaceClient {
  const profile = process.env.APPKIT_DEV_PROFILE;

  return profile ? createWorkspaceClient({ profile }) : createWorkspaceClient();
}
