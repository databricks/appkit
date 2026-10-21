import { definePolicy } from "@databricks/appkit/beta";

/** Listing one team requires membership; listing without a team is scoped in the query. */
export const canReadTeam = definePolicy<{ teamId?: string }>(
  async ({ actor, input, db }) => {
    if (input.teamId === undefined) return true;
    const rows = await db.sql`
      select 1 from team_members
      where user_id = ${actor.userId} and team_id = ${input.teamId}`;
    return rows.length > 0 || { deny: "Not a member of this team" };
  },
);

/**
 * An approver of the order's team, within their limit, who did not create it.
 * Runs inside the mutation's transaction, and locks what it reads: `for update`
 * pins the order's team, creator and total, `for share` pins the membership,
 * so neither can change between this decision and the approval's commit.
 */
export const canApproveOrder = definePolicy<{ id: number }>(
  async ({ actor, input, db }) => {
    const [order] = await db.sql<{
      team_id: string;
      created_by: string;
      total_cents: number;
    }>`
      select team_id, created_by, total_cents from orders
      where id = ${input.id}
      for update`;
    const [member] = order
      ? await db.sql<{ role: string; approval_limit_cents: number }>`
          select role, approval_limit_cents from team_members
          where user_id = ${actor.userId} and team_id = ${order.team_id}
          for share`
      : [];
    // Same answer for "missing" and "another team's": existence is not leaked.
    if (!order || !member) return { deny: "Order not found" };
    if (member.role !== "approver") return { deny: "Approver role required" };
    if (order.created_by === actor.userId) {
      return { deny: "You cannot approve your own order" };
    }
    if (order.total_cents > member.approval_limit_cents) {
      return { deny: "Order total exceeds your approval limit" };
    }
    return true;
  },
);
