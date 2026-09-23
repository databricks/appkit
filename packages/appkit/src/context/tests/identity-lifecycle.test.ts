import { describe, expect, test } from "vitest";

import { IdentityExpiredError } from "../../errors";
import { AuthenticationError } from "../../errors/authentication";
import { Plugin, toPlugin } from "../../plugin";
import { agents } from "../../plugins/agents";
import {
  createMockRequest,
  createMockWorkspaceClient,
  createTestApp,
  createTestPluginContext,
} from "../../testing";
import {
  getCallerContext,
  normalizeIdentityError,
  runInCallerContext,
} from "../execution-context";

const caller = {
  principal: { type: "user" as const, userId: "alice" },
  client: createMockWorkspaceClient(),
  workspaceId: Promise.resolve("workspace"),
  tokenFingerprint: "1234567890abcdef",
};
const upstream = Object.assign(new Error("secret-bearer-token"), {
  statusCode: 401,
});

class ExpiringPlugin extends Plugin {
  static manifest = {
    name: "expiring" as const,
    displayName: "Expiring",
    description: "probe",
    resources: { required: [], optional: [] },
  };
  exports() {
    return {
      query: () =>
        this.execute(
          async () => {
            throw upstream;
          },
          { default: {} },
        ),
      stream: async function* () {
        yield "start";
        throw upstream;
      },
    };
  }
}

describe("identity expiration", () => {
  test("agent HTTP responses expose a safe identity-expiration code", async () => {
    await using app = await createTestApp({
      plugins: [
        agents({
          agents: {
            probe: {
              instructions: "probe",
              model: {
                async *run() {
                  yield { type: "message_delta", content: "" };
                  throw upstream;
                },
              },
            },
          },
        }),
      ],
    });
    const response = await app.post("/invocations", {
      body: { input: "hi", stream: false },
      obo: { userId: "alice" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "IDENTITY_EXPIRED" });
    const streamed = await app.post("/api/agents/chat", {
      body: { message: "hi" },
      obo: { userId: "alice" },
    });
    const body = await streamed.text();
    expect(body).toContain("IDENTITY_EXPIRED");
    expect(body).not.toContain("secret-bearer-token");
  });
  test.each([
    { status: 401 },
    { response: { status: 401 } },
    new Error("wrapper", { cause: upstream }),
  ])(
    "converts structured downstream failures without retaining credentials",
    async (error) => {
      const result = runInCallerContext(caller, async () => {
        throw error;
      });
      const expired = await result.catch((err) => err);
      expect(expired).toBeInstanceOf(IdentityExpiredError);
      expect(expired.tokenFingerprint).toBe(caller.tokenFingerprint);
      expect(expired.isRetryable).toBe(false);
      expect(expired.statusCode).toBe(401);
      expect(expired.cause).toBeUndefined();
      expect(JSON.stringify(expired)).not.toContain("secret-bearer-token");
      expect(String(expired)).not.toContain("secret-bearer-token");
      expect(getCallerContext()).toBeUndefined();
    },
  );

  test("preserves non-401, local missing-token errors, and already typed failures", () => {
    for (const error of [
      new Error("401 in text"),
      { statusCode: 403 },
      AuthenticationError.missingToken(),
      new IdentityExpiredError("fingerprint"),
    ]) {
      try {
        runInCallerContext(caller, () => {
          throw error;
        });
      } catch (result) {
        expect(result).toBe(error);
      }
    }
  });

  test("normalizes tool failures under the caller before recording telemetry", async () => {
    const mock = createTestPluginContext({
      provider: {
        tool: () => {
          throw upstream;
        },
      },
    });
    await expect(
      runInCallerContext(caller, () =>
        mock.ctx.executeTool(
          createMockRequest() as never,
          "provider",
          "tool",
          {},
        ),
      ),
    ).rejects.toBeInstanceOf(IdentityExpiredError);
    await expect(
      mock.ctx.executeTool(
        createMockRequest({ obo: { userId: "alice" } }) as never,
        "provider",
        "tool",
        {},
      ),
    ).rejects.toBeInstanceOf(IdentityExpiredError);
    expect(normalizeIdentityError(upstream)).toBe(upstream);
  });

  test("plugin execution and delayed stream iteration surface the typed error", async () => {
    await using app = await createTestApp({
      plugins: [toPlugin(ExpiringPlugin)()],
      server: false,
    });
    const scoped = app.plugins.asUser(
      createMockRequest({ obo: { userId: "alice" } }),
    );
    await expect(scoped.expiring.query()).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: expect.any(IdentityExpiredError),
    });
    await expect(
      app.plugins.expiring.asUser(createMockRequest({ obo: true })).query(),
    ).resolves.toMatchObject({ ok: false, status: 401 });
    const stream = scoped.expiring.stream();
    expect(await stream.next()).toEqual({ value: "start", done: false });
    await expect(stream.next()).rejects.toBeInstanceOf(IdentityExpiredError);
    expect(getCallerContext()).toBeUndefined();
    expect(await app.plugins.expiring.query()).toMatchObject({
      ok: false,
      status: 401,
    });
  });
});
