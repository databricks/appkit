import { createHash } from "node:crypto";

import {
  AuthenticationError,
  ConfigurationError,
  InitializationError,
} from "../errors";
import { WarehouseResource } from "../resources/warehouse";
import {
  type ClientOptions,
  ConfigError,
  createWorkspaceClient,
  type WorkspaceClient,
} from "../workspace-client";
import { type CallerContext, snapshotCallerContext } from "./caller-context";
import { getClientOptions } from "./client-options";
import { warnContextDeprecation } from "./deprecation";
import { legacyUserContext, type UserContext } from "./user-context";

/**
 * Service context holds the service principal identity and workspace client.
 * This is initialized once at app startup and shared across all requests.
 */
export interface ServiceContextState {
  /** WorkspaceClient authenticated as the service principal */
  readonly client: WorkspaceClient;
  /** The service principal's user ID */
  readonly serviceUserId: string;
  /**
   * @deprecated Use getWarehouseId() from @databricks/appkit.
   * Retained for backward compatibility.
   */
  readonly warehouseId?: Promise<string>;
  /** Promise that resolves to the workspace ID */
  readonly workspaceId: Promise<string>;
}

/**
 * ServiceContext is a singleton that manages the service principal's
 * WorkspaceClient and workspace ID. WarehouseResource owns warehouse bindings.
 *
 * It's initialized once at app startup and provides the foundation
 * for both service principal and user context execution.
 */
export class ServiceContext {
  private static instance: ServiceContextState | null = null;
  private static initPromise: Promise<ServiceContextState> | null = null;

  /**
   * Initialize the service context. Should be called once at app startup.
   * Safe to call multiple times - will return the same instance.
   *
   * @param options - Which shared resources to resolve (derived from plugin manifests).
   * @param client - Optional pre-configured WorkspaceClient to use instead
   *   of creating one from environment credentials.
   */
  static async initialize(
    options?: { warehouseId?: boolean },
    client?: WorkspaceClient,
  ): Promise<ServiceContextState> {
    if (ServiceContext.instance) {
      return ServiceContext.instance;
    }

    if (ServiceContext.initPromise) {
      return ServiceContext.initPromise;
    }

    ServiceContext.initPromise = ServiceContext.createContext(options, client);
    ServiceContext.instance = await ServiceContext.initPromise;
    return ServiceContext.instance;
  }

  /**
   * Get the initialized service context.
   * @throws Error if not initialized
   */
  static get(): ServiceContextState {
    if (!ServiceContext.instance) {
      throw InitializationError.notInitialized(
        "ServiceContext",
        "Call ServiceContext.initialize() first",
      );
    }
    return ServiceContext.instance;
  }

  /**
   * Check if the service context has been initialized.
   */
  static isInitialized(): boolean {
    return ServiceContext.instance !== null;
  }

  /**
   * Create an immutable caller context from the existing user request headers.
   *
   * @param token - The user's access token from x-forwarded-access-token header
   * @param userId - The user's ID from x-forwarded-user header
   * @param userName - Optional user name
   * @param userEmail - Optional email from x-forwarded-email
   * @throws Error if token is not provided
   */
  static createCallerContext(
    token: string,
    userId: string,
    userName?: string,
    userEmail?: string,
  ): CallerContext {
    if (!token) {
      throw AuthenticationError.missingToken("user token");
    }

    // Local templates can configure only a profile, whose host the SDK resolved.
    const host =
      process.env.DATABRICKS_HOST ||
      (process.env.NODE_ENV === "development" && ServiceContext.isInitialized()
        ? ServiceContext.get().client.config?.host
        : undefined);
    if (!host) {
      throw ConfigurationError.missingEnvVar("DATABRICKS_HOST");
    }

    const serviceCtx = ServiceContext.get();

    // Create user client with the OAuth token from Databricks Apps
    // Note: We use authType: "pat" because the token is passed as a Bearer token
    // just like a PAT, even though it's technically an OAuth token
    const userClient = createWorkspaceClient({
      token,
      host,
      authType: "pat",
      clientOptions: getClientOptions(),
    });

    const tokenFingerprint = createHash("sha256")
      .update(token)
      .digest("hex")
      .slice(0, 16);

    return snapshotCallerContext({
      client: userClient,
      principal: { type: "user", userId, userName, userEmail },
      tokenFingerprint,
      workspaceId: serviceCtx.workspaceId,
    });
  }

  /** @deprecated Use ServiceContext.createCallerContext. */
  static createUserContext(
    token: string,
    userId: string,
    userName?: string,
    userEmail?: string,
  ): CallerContext & UserContext {
    warnContextDeprecation(
      "ServiceContext.createUserContext",
      "ServiceContext.createCallerContext",
    );
    const caller = ServiceContext.createCallerContext(
      token,
      userId,
      userName,
      userEmail,
    );
    const warehouseId = WarehouseResource.get()?.warehouseId;
    return legacyUserContext(caller, () => warehouseId);
  }

  /**
   * Get the client options for WorkspaceClient.
   * Exposed for testing purposes.
   */
  static getClientOptions(): ClientOptions {
    return getClientOptions();
  }

  private static async createContext(
    options?: { warehouseId?: boolean },
    client?: WorkspaceClient,
  ): Promise<ServiceContextState> {
    try {
      const wsClient =
        client ?? createWorkspaceClient({ clientOptions: getClientOptions() });

      const [resolvedWorkspaceId, currentUser, resolvedResources] =
        await Promise.all([
          ServiceContext.getWorkspaceId(wsClient),
          wsClient.currentUser.me(),
          WarehouseResource.resolve(wsClient, options?.warehouseId),
        ]);

      if (!currentUser.id) {
        throw ConfigurationError.resourceNotFound("Service user ID");
      }

      const resources = WarehouseResource.bind(resolvedResources);

      return Object.freeze({
        client: wsClient,
        serviceUserId: currentUser.id,
        get warehouseId() {
          warnContextDeprecation(
            "ServiceContextState.warehouseId",
            "getWarehouseId() from @databricks/appkit",
          );
          return resources.warehouseId;
        },
        workspaceId: Promise.resolve(resolvedWorkspaceId),
      });
    } catch (e) {
      if (e instanceof ConfigError) {
        throw ConfigurationError.databricksAuthenticationSetupFailed(
          e.baseMessage,
          { cause: e },
        );
      }
      throw e;
    }
  }

  private static async getWorkspaceId(
    client: WorkspaceClient,
  ): Promise<string> {
    if (process.env.DATABRICKS_WORKSPACE_ID) {
      return process.env.DATABRICKS_WORKSPACE_ID;
    }

    const response = (await client.apiClient.request({
      path: "/api/2.0/preview/scim/v2/Me",
      method: "GET",
      headers: new Headers(),
      raw: false,
      query: {},
      responseHeaders: ["x-databricks-org-id"],
    })) as { "x-databricks-org-id": string };

    if (!response["x-databricks-org-id"]) {
      throw ConfigurationError.resourceNotFound("Workspace ID");
    }

    return response["x-databricks-org-id"];
  }

  /**
   * Reset the service context. Only for testing purposes.
   */
  static reset(): void {
    ServiceContext.instance = null;
    ServiceContext.initPromise = null;
    WarehouseResource.reset();
  }
}
