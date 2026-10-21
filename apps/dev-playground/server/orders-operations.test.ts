import { runOperation } from "@databricks/appkit/beta";
import { beforeEach, describe, expect, test } from "vitest";

import { approveOrder, listOrders } from "../config/database/routes/orders";

interface Order {
  id: number;
  team_id: string;
  created_by: string;
  status: string;
  total_cents: number;
  approved_by: string | null;
}

const members = [
  {
    user_id: "alice",
    team_id: "red",
    role: "approver",
    approval_limit_cents: 100_000,
  },
  { user_id: "bob", team_id: "red", role: "member", approval_limit_cents: 0 },
  {
    user_id: "carol",
    team_id: "blue",
    role: "approver",
    approval_limit_cents: 100_000,
  },
];

let orders: Order[];

/** Every statement the fake answered, to check what the policies lock. */
let statements: string[];

/**
 * Answers the example's statements from memory. The conditional update checks
 * and writes in one synchronous step, as Postgres does under its row lock, so
 * two concurrent approvals cannot both match `status = 'pending'`. Each
 * transaction undoes only its own writes, so one rollback cannot erase
 * another's commit.
 */
function fakeDb() {
  const sqlFor =
    (undo?: (() => void)[]) =>
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      statements.push(text);
      await Promise.resolve();
      if (text.includes("select 1 from team_members")) {
        const [user, team] = values;
        return members.filter((m) => m.user_id === user && m.team_id === team);
      }
      if (text.includes("select o.* from orders o")) {
        const [user, team] = values;
        const teams = members
          .filter((m) => m.user_id === user)
          .map((m) => m.team_id);
        return orders.filter(
          (o) =>
            teams.includes(o.team_id) && (team === null || o.team_id === team),
        );
      }
      if (text.includes("select team_id, created_by, total_cents")) {
        const [id] = values;
        return orders.filter((o) => o.id === id).map((o) => ({ ...o }));
      }
      if (text.includes("select role, approval_limit_cents")) {
        const [user, team] = values;
        return members.filter((m) => m.user_id === user && m.team_id === team);
      }
      if (text.includes("update orders set status")) {
        const [user, id] = values;
        const order = orders.find((o) => o.id === id && o.status === "pending");
        if (!order) return [];
        const before = { ...order };
        Object.assign(order, { status: "approved", approved_by: user });
        undo?.push(() => Object.assign(order, before));
        return [{ ...order }];
      }
      throw new Error(`unexpected statement: ${text}`);
    };
  const db = {
    sql: sqlFor(),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const undo: (() => void)[] = [];
      try {
        return await callback({ sql: sqlFor(undo) });
      } catch (error) {
        for (const step of undo.reverse()) step();
        throw error;
      }
    },
  };
  return db as unknown as Parameters<typeof runOperation>[2];
}

const as = (userId: string) => ({ userId });

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    return (error as { statusCode: number }).statusCode;
  }
}

beforeEach(() => {
  statements = [];
  orders = [
    {
      id: 1,
      team_id: "red",
      created_by: "bob",
      status: "pending",
      total_cents: 25_000,
      approved_by: null,
    },
    {
      id: 2,
      team_id: "red",
      created_by: "bob",
      status: "pending",
      total_cents: 500_000,
      approved_by: null,
    },
    {
      id: 3,
      team_id: "blue",
      created_by: "carol",
      status: "pending",
      total_cents: 9_900,
      approved_by: null,
    },
  ];
});

describe("orders.list", () => {
  test("returns only the caller's teams, filtered in the query", async () => {
    const rows = await runOperation(
      listOrders,
      { actor: as("bob"), input: {} },
      fakeDb(),
    );
    expect(rows.map((o) => o.id)).toEqual([1, 2]);
  });

  test("denies another team's orders when the caller changes teamId", async () => {
    expect(
      await statusOf(
        runOperation(
          listOrders,
          { actor: as("bob"), input: { teamId: "blue" } },
          fakeDb(),
        ),
      ),
    ).toBe(403);
  });
});

describe("orders.approve", () => {
  test("approves a pending order within the approver's limit", async () => {
    const order = await runOperation(
      approveOrder,
      { actor: as("alice"), input: { id: "1" } },
      fakeDb(),
    );
    expect(order).toMatchObject({
      id: 1,
      status: "approved",
      approved_by: "alice",
    });
  });

  test.each([
    ["a member without the approver role", "bob", 1],
    ["an approver over their limit", "alice", 2],
    ["an approver of another team", "carol", 1],
    ["the order's own creator", "carol", 3],
  ])("denies %s and leaves the order pending", async (_name, user, id) => {
    expect(
      await statusOf(
        runOperation(
          approveOrder,
          { actor: as(user), input: { id } },
          fakeDb(),
        ),
      ),
    ).toBe(403);
    expect(orders.find((o) => o.id === id)?.status).toBe("pending");
  });

  test("refuses an order that is no longer pending", async () => {
    orders[0].status = "rejected";
    expect(
      await statusOf(
        runOperation(
          approveOrder,
          { actor: as("alice"), input: { id: 1 } },
          fakeDb(),
        ),
      ),
    ).toBe(409);
    expect(orders[0]).toMatchObject({ status: "rejected", approved_by: null });
  });

  test("lets exactly one of two concurrent approvals win", async () => {
    const db = fakeDb();
    const statuses = await Promise.all([
      statusOf(
        runOperation(
          approveOrder,
          { actor: as("alice"), input: { id: 1 } },
          db,
        ),
      ),
      statusOf(
        runOperation(
          approveOrder,
          { actor: as("alice"), input: { id: 1 } },
          db,
        ),
      ),
    ]);
    expect(statuses.sort()).toEqual([200, 409]);
    // The losing call's rollback must not take the winner's write with it.
    expect(orders[0]).toMatchObject({
      status: "approved",
      approved_by: "alice",
    });
  });

  test("locks the order and the membership it authorizes against", async () => {
    await runOperation(
      approveOrder,
      { actor: as("alice"), input: { id: 1 } },
      fakeDb(),
    );
    expect(statements.find((s) => s.includes("from orders"))).toMatch(
      /for update\s*$/,
    );
    expect(statements.find((s) => s.includes("from team_members"))).toMatch(
      /for share\s*$/,
    );
  });

  test("rejects a non-numeric id before any statement runs", async () => {
    expect(
      await statusOf(
        runOperation(
          approveOrder,
          { actor: as("alice"), input: { id: "1; drop table" } },
          fakeDb(),
        ),
      ),
    ).toBe(400);
  });
});
