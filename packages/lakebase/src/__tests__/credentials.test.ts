import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { ApiClient, Config } from "@databricks/sdk-experimental";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateDatabaseCredential } from "../credentials";
import {
  type DatabaseCredential,
  RequestedClaimsPermissionSet,
} from "../types";

// Mock the @databricks/sdk-experimental module
vi.mock("@databricks/sdk-experimental", () => {
  const mockRequest = vi.fn();

  return {
    Config: vi.fn(),
    ApiClient: vi.fn().mockImplementation(() => ({
      request: mockRequest,
    })),
  };
});

describe("Lakebase Authentication", () => {
  let mockWorkspaceClient: WorkspaceClient;
  let mockApiClient: ApiClient;

  beforeEach(() => {
    vi.clearAllMocks();

    // Get the mocked ApiClient constructor
    const ApiClientConstructor = ApiClient as unknown as ReturnType<
      typeof vi.fn
    >;
    mockApiClient = new ApiClientConstructor(
      new Config({ host: "https://test.databricks.com" }),
    );

    // Setup mock workspace client with apiClient
    mockWorkspaceClient = {
      config: {
        host: "https://test.databricks.com",
      },
      apiClient: mockApiClient,
    } as WorkspaceClient;
  });

  describe("generateDatabaseCredential", () => {
    it("should generate database credentials with proper endpoint format", async () => {
      const mockCredential: DatabaseCredential = {
        token: "mock-oauth-token-abc123",
        expire_time: "2026-02-06T18:00:00Z",
      };

      // Setup mock response
      vi.mocked(mockApiClient.request).mockResolvedValue(mockCredential);

      const credential = await generateDatabaseCredential(mockWorkspaceClient, {
        endpoint: "projects/test-project/branches/main/endpoints/primary",
      });

      // Verify API call
      expect(mockApiClient.request).toHaveBeenCalledWith({
        path: "/api/2.0/postgres/credentials",
        method: "POST",
        headers: expect.any(Headers),
        raw: false,
        payload: {
          endpoint: "projects/test-project/branches/main/endpoints/primary",
        },
      });

      // Verify response
      expect(credential).toEqual(mockCredential);
      expect(credential.token).toBe("mock-oauth-token-abc123");
      expect(credential.expire_time).toBe("2026-02-06T18:00:00Z");
    });

    it("should include claims when provided", async () => {
      const mockCredential: DatabaseCredential = {
        token: "mock-oauth-token-with-claims",
        expire_time: "2026-02-06T18:00:00Z",
      };

      vi.mocked(mockApiClient.request).mockResolvedValue(mockCredential);

      await generateDatabaseCredential(mockWorkspaceClient, {
        endpoint: "projects/test-project/branches/main/endpoints/primary",
        claims: [
          {
            permission_set: RequestedClaimsPermissionSet.READ_ONLY,
            resources: [
              { table_name: "catalog.schema.users" },
              { table_name: "catalog.schema.orders" },
            ],
          },
        ],
      });

      // Verify claims are included in payload
      expect(mockApiClient.request).toHaveBeenCalledWith({
        path: "/api/2.0/postgres/credentials",
        method: "POST",
        headers: expect.any(Headers),
        raw: false,
        payload: {
          endpoint: "projects/test-project/branches/main/endpoints/primary",
          claims: [
            {
              permission_set: RequestedClaimsPermissionSet.READ_ONLY,
              resources: [
                { table_name: "catalog.schema.users" },
                { table_name: "catalog.schema.orders" },
              ],
            },
          ],
        },
      });
    });

    it("should handle token expiration time parsing", async () => {
      const futureTime = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
      const mockCredential: DatabaseCredential = {
        token: "mock-token",
        expire_time: futureTime,
      };

      vi.mocked(mockApiClient.request).mockResolvedValue(mockCredential);

      const credential = await generateDatabaseCredential(mockWorkspaceClient, {
        endpoint: "projects/test-project/branches/main/endpoints/primary",
      });

      // Verify expiration time is in the future
      const expiresAt = new Date(credential.expire_time).getTime();
      expect(expiresAt).toBeGreaterThan(Date.now());
    });

    it("should handle API errors gracefully", async () => {
      const mockError = new Error("API request failed");
      vi.mocked(mockApiClient.request).mockRejectedValue(mockError);

      await expect(
        generateDatabaseCredential(mockWorkspaceClient, {
          endpoint: "projects/invalid/branches/main/endpoints/primary",
        }),
      ).rejects.toThrow("API request failed");
    });

    it("should use correct workspace host for API calls", async () => {
      const customHost = "https://custom-workspace.databricks.com";

      // Create a new mock API client for the custom workspace
      const ApiClientConstructor = ApiClient as unknown as ReturnType<
        typeof vi.fn
      >;
      const customApiClient = new ApiClientConstructor(
        new Config({ host: customHost }),
      );

      const customWorkspaceClient = {
        config: { host: customHost },
        apiClient: customApiClient,
      } as WorkspaceClient;

      const mockCredential: DatabaseCredential = {
        token: "mock-token",
        expire_time: "2026-02-06T18:00:00Z",
      };

      vi.mocked(customApiClient.request).mockResolvedValue(mockCredential);

      await generateDatabaseCredential(customWorkspaceClient, {
        endpoint: "projects/test/branches/main/endpoints/primary",
      });

      // Verify the request was made with the correct workspace client
      expect(customApiClient.request).toHaveBeenCalledWith({
        path: "/api/2.0/postgres/credentials",
        method: "POST",
        headers: expect.any(Headers),
        raw: false,
        payload: {
          endpoint: "projects/test/branches/main/endpoints/primary",
        },
      });
    });
  });
});
