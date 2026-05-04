import { defineSchema } from "@databricks/appkit";

/**
 * Application database schema. The database plugin auto-loads this file
 * (see config/database/) and uses it as the single source of truth for
 *  - the typed `db.<entity>` browser client,
 *  - the auto-mounted `/api/database/<entity>` REST routes,
 *  - and runtime drift detection against the live Lakebase DB.
 *
 * Add tables under the returned object and run:
 *   npx appkit db migration generate
 *   npx appkit db migrate up
 *
 * Example:
 *   user: table("user", {
 *     id: id(),
 *     email: text().notNull(),
 *     createdAt: timestamp().defaultNow().notNull(),
 *   }),
 */
// biome-ignore lint/correctness/noEmptyPattern: schema is intentionally empty in the starter template.
export default defineSchema(({}) => ({}));
