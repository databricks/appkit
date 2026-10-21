import {
  defineMutation,
  defineQuery,
  OperationError,
} from "@databricks/appkit/beta";
import { z } from "zod";

import { canApproveOrder, canReadTeam } from "../policies";

interface Order {
  id: number;
  team_id: string;
  created_by: string;
  status: string;
  total_cents: number;
  approved_by: string | null;
}

export const listOrders = defineQuery({
  input: z.object({ teamId: z.string().min(1).optional() }),
  authorize: canReadTeam,
  // The membership join is the access rule: rows of other teams are never read.
  execute: ({ actor, input, db }) => db.sql<Order>`
    select o.* from orders o
    join team_members m on m.team_id = o.team_id and m.user_id = ${actor.userId}
    where ${input.teamId ?? null}::text is null or o.team_id = ${input.teamId ?? null}
    order by o.id`,
});

export const approveOrder = defineMutation({
  input: z.object({ id: z.coerce.number().int().positive() }),
  authorize: canApproveOrder,
  execute: async ({ actor, input, db }) => {
    // The state check is part of the write: of two concurrent approvals, the
    // second re-reads the committed row, matches nothing, and gets a 409.
    const [order] = await db.sql<Order>`
      update orders set status = 'approved', approved_by = ${actor.userId}
      where id = ${input.id} and status = 'pending'
      returning *`;
    if (!order) throw new OperationError(409, "Order is not pending");
    return order;
  },
});

export default {
  "GET /orders": listOrders,
  "POST /orders/:id/approve": approveOrder,
};
