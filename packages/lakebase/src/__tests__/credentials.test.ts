import { beforeEach, describe, expect, it, vi } from "vitest";

import { getUsernameWithApiLookup } from "../config";
import { generateDatabaseCredential } from "../credentials";
import {
  type DatabaseCredential,
  type LegacyWorkspaceClientLike,
  RequestedClaimsPermissionSet,
} from "../types";

describe("Lakebase Authentication", () => {
  let mockWorkspaceClient: LegacyWorkspaceClientLike;
  let mockApiClient: LegacyWorkspaceClientLike["apiClient"];

  beforeEach(() => {
    vi.clearAllMocks();
    mockApiClient = { request: vi.fn() };
    mockWorkspaceClient = {
      currentUser: { me: vi.fn() },
      apiClient: mockApiClient,
    };
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
  });

  describe("request-capable (AppKit modular) client", () => {
    const credential: DatabaseCredential = {
      token: "modular-token",
      expire_time: "2026-02-06T18:00:00Z",
    };

    it("posts the snake_case request body through request()", async () => {
      const request = vi.fn(async () => Response.json(credential));
      const claims = [
        {
          permission_set: RequestedClaimsPermissionSet.READ_ONLY,
          resources: [{ table_name: "catalog.schema.users" }],
        },
      ];

      const result = await generateDatabaseCredential(
        { request },
        { endpoint: "projects/p/branches/main/endpoints/primary", claims },
      );

      expect(result).toEqual(credential);
      expect(request).toHaveBeenCalledWith({
        method: "POST",
        path: "/api/2.0/postgres/credentials",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          endpoint: "projects/p/branches/main/endpoints/primary",
          claims,
        }),
      });
    });

    it("prefers request() over a legacy apiClient on the same object", async () => {
      // The AppKit facade exposes both; the modular path must win.
      const request = vi.fn(async () => Response.json(credential));
      const client = { ...mockWorkspaceClient, request };

      await generateDatabaseCredential(client, { endpoint: "e" });

      expect(request).toHaveBeenCalledOnce();
      expect(mockApiClient.request).not.toHaveBeenCalled();
    });

    it("rejects a malformed credential response", async () => {
      const request = vi.fn(async () => Response.json({ token: "t" }));
      await expect(
        generateDatabaseCredential({ request }, { endpoint: "e" }),
      ).rejects.toThrow();
    });

    it("resolves the username via the SCIM Me endpoint", async () => {
      const prev = {
        PGUSER: process.env.PGUSER,
        DATABRICKS_CLIENT_ID: process.env.DATABRICKS_CLIENT_ID,
      };
      delete process.env.PGUSER;
      delete process.env.DATABRICKS_CLIENT_ID;
      try {
        const request = vi.fn(async () =>
          Response.json({ userName: "someone@example.com" }),
        );
        await expect(
          getUsernameWithApiLookup({ workspaceClient: { request } }),
        ).resolves.toBe("someone@example.com");
        expect(request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: "GET",
            path: "/api/2.0/preview/scim/v2/Me",
          }),
        );
      } finally {
        Object.assign(process.env, prev);
        for (const [k, v] of Object.entries(prev)) {
          if (v === undefined) delete process.env[k];
        }
      }
    });
  });
});
