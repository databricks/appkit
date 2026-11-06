import { afterEach, describe, expect, it, vi } from "vitest";

import { getLakebasePool } from "./databricks-client";

// Stand in for the optional `@databricks/appkit` peer the Lakebase probe imports.
const { mockCreateLakebasePool, mockGetUsernameWithApiLookup } = vi.hoisted(
  () => ({
    mockCreateLakebasePool: vi.fn(() => ({ query: vi.fn(), end: vi.fn() })),
    mockGetUsernameWithApiLookup: vi.fn(),
  }),
);
vi.mock("@databricks/appkit", () => ({
  createLakebasePool: mockCreateLakebasePool,
  getUsernameWithApiLookup: mockGetUsernameWithApiLookup,
}));

describe("getLakebasePool", () => {
  afterEach(() => vi.clearAllMocks());

  it("connects as the user resolved from the client when PGUSER is unset", async () => {
    const client = {};
    mockGetUsernameWithApiLookup.mockResolvedValueOnce("me@example.com");

    await getLakebasePool(client);

    expect(mockGetUsernameWithApiLookup).toHaveBeenCalledWith({
      workspaceClient: client,
    });
    expect(mockCreateLakebasePool).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceClient: client,
        user: "me@example.com",
      }),
    );
  });

  it("leaves user unset when the lookup fails, so the pool's own error surfaces", async () => {
    mockGetUsernameWithApiLookup.mockResolvedValueOnce(undefined);

    await getLakebasePool({});

    expect(mockCreateLakebasePool).toHaveBeenCalledWith(
      expect.objectContaining({ user: undefined }),
    );
  });
});
