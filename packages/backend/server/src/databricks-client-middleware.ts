import type express from "express";
import { WorkspaceClient, type sql } from "@databricks/sdk-experimental";

import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  userDatabricksClient: WorkspaceClient;
  serviceDatabricksClient: WorkspaceClient;
  userId: string;
  serviceUserId: string;
  warehouseId: Promise<string>;
  workspaceId: Promise<string>;
};

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

export async function databricksClientMiddleware(): Promise<express.RequestHandler> {
  const serviceDatabricksClient = new WorkspaceClient({});

  const warehouseId = getWarehouseId(serviceDatabricksClient);
  const workspaceId = getWorkspaceId(serviceDatabricksClient);
  const serviceUserId = (await serviceDatabricksClient.currentUser.me()).id!;

  return async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const userToken = req.headers["x-forwarded-access-token"] as string;
    let userDatabricksClient: WorkspaceClient;
    if (userToken) {
      userDatabricksClient = new WorkspaceClient({
        token: userToken,
      });
    } else if (process.env.NODE_ENV === "development") {
      // in local development service and no user token are the same
      // TODO: use `databricks apps run-local` to fix this
      userDatabricksClient = serviceDatabricksClient;
    } else {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    let userName = req.headers["x-forwarded-user"] as string;
    if (!userName && process.env.NODE_ENV !== "development") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    } else {
      userName = serviceUserId;
    }

    return asyncLocalStorage.run(
      {
        userDatabricksClient,
        serviceDatabricksClient,
        warehouseId,
        workspaceId,
        userId: userName,
        serviceUserId,
      },
      async () => {
        return next();
      },
    );
  };
}

export function getRequestContext(): RequestContext {
  const store = asyncLocalStorage.getStore();
  if (!store) {
    throw new Error("Request context not found");
  }
  return store;
}

async function getWorkspaceId(
  workspaceClient: WorkspaceClient,
): Promise<string> {
  if (process.env.DATABRICKS_WORKSPACE_ID) {
    return process.env.DATABRICKS_WORKSPACE_ID;
  }

  const response = (await workspaceClient.apiClient.request({
    path: "/api/2.0/preview/scim/v2/Me",
    method: "GET",
    headers: new Headers(),
    raw: false,
    query: {},
    responseHeaders: ["x-databricks-org-id"],
  })) as { "x-databricks-org-id": string };

  if (!response["x-databricks-org-id"]) {
    throw new Error("Workspace ID not found");
  }

  return response["x-databricks-org-id"];
}

async function getWarehouseId(
  workspaceClient: WorkspaceClient,
): Promise<string> {
  if (process.env.NODE_ENV === "development") {
    const response = (await workspaceClient.apiClient.request({
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
      return priorities[a.state!] - priorities[b.state!];
    });

    if (response.warehouses.length === 0) {
      throw new Error(
        "Warehouse ID not found. Please configure the DATABRICKS_WAREHOUSE_ID environment variable.",
      );
    }

    const firstWarehouse = warehouses[0];
    if (
      firstWarehouse.state === "DELETED" ||
      firstWarehouse.state === "DELETING"
    ) {
      throw new Error(
        "Warehouse ID not found. Please configure the DATABRICKS_WAREHOUSE_ID environment variable.",
      );
    }

    return firstWarehouse?.id!;
  }

  throw new Error(
    "Warehouse ID not found. Please configure the DATABRICKS_WAREHOUSE_ID environment variable.",
  );
}
