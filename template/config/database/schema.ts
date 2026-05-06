import { defineSchema } from "@databricks/appkit";

/**
 * Application database schema. Source of truth for the typed browser client,
 * `/api/database/<entity>` routes, and drift detection.
 *
 * Add tables, then `npx appkit db migration generate <name>` + `migrate up`.
 *
 * Example:
 *   import { defineSchema, id, text, timestamp } from "@databricks/appkit";
 *
 *   export default defineSchema(({ table }) => ({
 *     user: table("user", {
 *       id: id(),
 *       email: text().notNull(),
 *       createdAt: timestamp().defaultNow().notNull(),
 *     }),
 *   }));
 */
// biome-ignore lint/correctness/noEmptyPattern: schema is intentionally empty in the starter template.
export default defineSchema(({}) => ({}));
