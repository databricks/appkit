import type { Server } from "node:http";
import {
  setupDatabricksEnv,
  type TestContextOptions,
} from "@tools/test-helpers";
import type { Mock } from "vitest";
import { vi } from "vitest";
import { AppManager } from "../../app";
import { ServiceContext } from "../../context/service-context";
import { createApp } from "../../core";
import { server as serverPlugin } from "../../server";

export interface TestServerConfig {
  port?: number;
  executeStatementResponse?: any;
  getStatementResponse?: any;
  contextOptions?: TestContextOptions;
  /** Plugins to include (server plugin is always added automatically) */
  plugins: any[];
  /** Function to extend the server via server.extend() before starting */
  extend?: (app: import("express").Application) => void;
}

export interface MockWorkspaceClient {
  statementExecution: {
    executeStatement: Mock;
    getStatement: Mock;
  };
}

export interface TestServerResult {
  server: Server;
  baseUrl: string;
  port: number;
  mockWorkspaceClient: MockWorkspaceClient;
  cleanup: () => Promise<void>;
  getAppQueryMock: Mock;
}

const usedPorts = new Set<number>();

function getAvailablePort(): number {
  let port = 10000 + Math.floor(Math.random() * 10000);
  while (usedPorts.has(port)) {
    port++;
  }
  usedPorts.add(port);
  return port;
}

export function createTestWorkspaceClient(
  config: TestServerConfig = {},
): MockWorkspaceClient {
  const defaultExecuteResponse = {
    status: { state: "SUCCEEDED" },
    statement_id: "stmt-test-123",
    result: {
      data_array: [],
    },
    manifest: {
      schema: {
        columns: [],
      },
    },
  };

  const defaultGetStatementResponse = {
    status: { state: "SUCCEEDED" },
    statement_id: "stmt-test-123",
    result: {
      external_links: [],
    },
    manifest: {
      schema: {
        columns: [],
      },
    },
  };

  return {
    statementExecution: {
      executeStatement: vi
        .fn()
        .mockResolvedValue(
          config.executeStatementResponse ?? defaultExecuteResponse,
        ),
      getStatement: vi
        .fn()
        .mockResolvedValue(
          config.getStatementResponse ?? defaultGetStatementResponse,
        ),
    },
  };
}

export async function createTestServer(
  config: TestServerConfig = {},
): Promise<TestServerResult> {
  const port = config.port ?? getAvailablePort();

  setupDatabricksEnv();
  ServiceContext.reset();

  const mockWorkspaceClient = createTestWorkspaceClient(config);

  // Mock getAppQuery before creating the app so all plugin instances use it
  const getAppQueryMock = vi.fn().mockResolvedValue(null);
  const getAppQuerySpy = vi
    .spyOn(AppManager.prototype, "getAppQuery")
    .mockImplementation(getAppQueryMock);

  const contextModule = await import("../../context/service-context");

  const serviceContext = {
    client: mockWorkspaceClient as any,
    serviceUserId: config.contextOptions?.serviceUserId ?? "test-service-user",
    warehouseId: Promise.resolve(
      config.contextOptions?.warehouseId ?? "test-warehouse-id",
    ),
    workspaceId: Promise.resolve(
      config.contextOptions?.workspaceId ?? "test-workspace-id",
    ),
  };

  const getSpy = vi
    .spyOn(contextModule.ServiceContext, "get")
    .mockReturnValue(serviceContext);

  const initSpy = vi
    .spyOn(contextModule.ServiceContext, "initialize")
    .mockResolvedValue(serviceContext);

  const isInitializedSpy = vi
    .spyOn(contextModule.ServiceContext, "isInitialized")
    .mockReturnValue(true);

  const createUserContextSpy = vi
    .spyOn(contextModule.ServiceContext, "createUserContext")
    .mockImplementation(
      (_token: string, userId: string, userName?: string) => ({
        client: mockWorkspaceClient as any,
        userId,
        userName,
        warehouseId: serviceContext.warehouseId,
        workspaceId: serviceContext.workspaceId,
        isUserContext: true,
      }),
    );

  const plugins: any[] = [
    serverPlugin({
      port,
      host: "127.0.0.1",
      autoStart: false,
    }),
    ...config.plugins,
  ];

  const app = await createApp({ plugins });

  if (config.extend) {
    app.server.extend(config.extend);
  }

  await app.server.start();
  const server = app.server.getServer();
  const baseUrl = `http://127.0.0.1:${port}`;

  await new Promise((resolve) => setTimeout(resolve, 50));

  const cleanup = async () => {
    getAppQuerySpy.mockRestore();
    getSpy.mockRestore();
    initSpy.mockRestore();
    isInitializedSpy.mockRestore();
    createUserContextSpy.mockRestore();

    usedPorts.delete(port);

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  };

  return {
    server,
    baseUrl,
    port,
    mockWorkspaceClient,
    cleanup,
    getAppQueryMock,
  };
}
