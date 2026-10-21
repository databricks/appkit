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

/** An approver of the order's team, within their limit, who did not create it. */
export const canApproveOrder = definePolicy<{ id: number }>(
  async ({ actor, input, db }) => {
    const [row] = await db.sql<{
      created_by: string;
      total_cents: number;
      role: string | null;
      approval_limit_cents: number | null;
    }>`
      select o.created_by, o.total_cents, m.role, m.approval_limit_cents
      from orders o
      left join team_members m
        on m.team_id = o.team_id and m.user_id = ${actor.userId}
      where o.id = ${input.id}`;
    // Same answer for "missing" and "another team's": existence is not leaked.
    if (!row?.role) return { deny: "Order not found" };
    if (row.role !== "approver") return { deny: "Approver role required" };
    if (row.created_by === actor.userId) {
      return { deny: "You cannot approve your own order" };
    }
    if (row.total_cents > (row.approval_limit_cents ?? 0)) {
      return { deny: "Order total exceeds your approval limit" };
    }
    return true;
  },
);
