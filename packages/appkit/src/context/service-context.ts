import {
  type ClientOptions,
  type sql,
  WorkspaceClient,
} from "@databricks/sdk-experimental";
import { coerce } from "semver";
import {
  name as productName,
  version as productVersion,
} from "../../package.json";
import {
  AuthenticationError,
  ConfigurationError,
  InitializationError,
} from "../errors";
import type { UserContext } from "./user-context";

/**
 * Service context holds the service principal client and shared resources.
 * This is initialized once at app startup and shared across all requests.
 */
export interface ServiceContextState {
  /** WorkspaceClient authenticated as the service principal */
  client: WorkspaceClient;
  /** The service principal's user ID */
  serviceUserId: string;
  /** Promise that resolves to the warehouse ID */
  warehouseId: Promise<string>;
  /** Promise that resolves to the workspace ID */
  workspaceId: Promise<string>;
}

function getClientOptions(): ClientOptions {
  const isDev = process.env.NODE_ENV === "development";
  const semver = coerce(productVersion);
  const normalizedVersion = (semver?.version ??
    productVersion) as ClientOptions["productVersion"];

  return {
    product: productName,
    productVersion: normalizedVersion,
    ...(isDev && { userAgentExtra: { mode: "dev" } }),
  };
}

/**
 * ServiceContext is a singleton that manages the service principal's
 * WorkspaceClient and shared resources like warehouse/workspace IDs.
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
   */
  static async initialize(): Promise<ServiceContextState> {
    if (ServiceContext.instance) {
      return ServiceContext.instance;
    }

    if (ServiceContext.initPromise) {
      return ServiceContext.initPromise;
    }

    ServiceContext.initPromise = ServiceContext.createContext();
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
   * Create a user context from request headers.
   *
   * @param token - The user's access token from x-forwarded-access-token header
   * @param userId - The user's ID from x-forwarded-user header
   * @param userName - Optional user name
   * @throws Error if token is not provided
   */
  static createUserContext(
    token: string,
    userId: string,
    userName?: string,
  ): UserContext {
    if (!token) {
      throw AuthenticationError.missingToken("user token");
    }

    const host = process.env.DATABRICKS_HOST;
    if (!host) {
      throw ConfigurationError.missingEnvVar("DATABRICKS_HOST");
    }

    const serviceCtx = ServiceContext.get();

    // Create user client with the OAuth token from Databricks Apps
    // Note: We use authType: "pat" because the token is passed as a Bearer token
    // just like a PAT, even though it's technically an OAuth token
    const userClient = new WorkspaceClient(
      {
        token,
        host,
        authType: "pat",
      },
      getClientOptions(),
    );

    return {
      client: userClient,
      userId,
      userName,
      warehouseId: serviceCtx.warehouseId,
      workspaceId: serviceCtx.workspaceId,
      isUserContext: true,
    };
  }

  /**
   * Get the client options for WorkspaceClient.
   * Exposed for testing purposes.
   */
  static getClientOptions(): ClientOptions {
    return getClientOptions();
  }

  private static async createContext(): Promise<ServiceContextState> {
    const client = new WorkspaceClient({}, getClientOptions());

    const warehouseId = ServiceContext.getWarehouseId(client);
    const workspaceId = ServiceContext.getWorkspaceId(client);
    const currentUser = await client.currentUser.me();

    if (!currentUser.id) {
      throw ConfigurationError.resourceNotFound("Service user ID");
    }

    return {
      client,
      serviceUserId: currentUser.id,
      warehouseId,
      workspaceId,
    };
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

  private static async getWarehouseId(
    client: WorkspaceClient,
  ): Promise<string> {
    if (process.env.DATABRICKS_WAREHOUSE_ID) {
      return process.env.DATABRICKS_WAREHOUSE_ID;
    }

    if (process.env.NODE_ENV === "development") {
      const response = (await client.apiClient.request({
        path: "/api/2.0/sql/warehouses",
        method: "GET",
        headers: new Headers(),
        raw: false,
        query: {
          skip_cannot_use: "true",
        },
      })) as { warehouses: sql.EndpointInfo[] };

      const priorities: Record<sql.State, number> = {
        RUNNING: 0,
        STOPPED: 1,
        STARTING: 2,
        STOPPING: 3,
        DELETED: 99,
        DELETING: 99,
      };

      const warehouses = (response.warehouses || []).sort((a, b) => {
        return (
          priorities[a.state as sql.State] - priorities[b.state as sql.State]
        );
      });

      if (response.warehouses.length === 0) {
        throw ConfigurationError.resourceNotFound(
          "Warehouse ID",
          "Please configure the DATABRICKS_WAREHOUSE_ID environment variable",
        );
      }

      const firstWarehouse = warehouses[0];
      if (
        firstWarehouse.state === "DELETED" ||
        firstWarehouse.state === "DELETING" ||
        !firstWarehouse.id
      ) {
        throw ConfigurationError.resourceNotFound(
          "Warehouse ID",
          "Please configure the DATABRICKS_WAREHOUSE_ID environment variable",
        );
      }

      return firstWarehouse.id;
    }

    throw ConfigurationError.resourceNotFound(
      "Warehouse ID",
      "Please configure the DATABRICKS_WAREHOUSE_ID environment variable",
    );
  }

  /**
   * Reset the service context. Only for testing purposes.
   */
  static reset(): void {
    ServiceContext.instance = null;
    ServiceContext.initPromise = null;
  }
}
