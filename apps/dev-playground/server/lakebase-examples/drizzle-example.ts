import { createLakebasePool } from "@databricks/appkit";
import { count, desc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  index,
  jsonb,
  pgSchema,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import type { IAppRouter } from "shared";

/**
 * Drizzle ORM example with type-safe schema definitions.
 *
 * This example demonstrates:
 * - Type-safe schema definitions with drizzle-orm
 * - Automatic type inference from schema
 * - Query builder with TypeScript autocompletion
 * - Aggregations and complex queries
 * - JSON field handling
 */

// Define schema
const drizzleExampleSchema = pgSchema("drizzle_example");

export const activityLogs = drizzleExampleSchema.table(
  "activity_logs",
  {
    id: serial("id").primaryKey(),
    userId: varchar("user_id", { length: 100 }).notNull(),
    action: varchar("action", { length: 255 }).notNull(),
    metadata: jsonb("metadata"),
    timestamp: timestamp("timestamp").defaultNow(),
  },
  (table) => ({
    userIdIdx: index("user_id_idx").on(table.userId),
  }),
);

type NewActivityLog = typeof activityLogs.$inferInsert;

let db: ReturnType<typeof drizzle>;
let pool: Pool;

export async function setup(user?: string) {
  pool = createLakebasePool({ user });
  db = drizzle(pool);

  // For production apps, use: npx drizzle-kit push or drizzle-kit generate + migrate
  await pool.query(`CREATE SCHEMA IF NOT EXISTS drizzle_example`);

  // Create table using raw SQL
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drizzle_example.activity_logs (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(100) NOT NULL,
      action VARCHAR(255) NOT NULL,
      metadata JSONB,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS user_id_idx 
      ON drizzle_example.activity_logs(user_id);
  `);

  // Seed if empty
  const countResult = await db.select({ count: count() }).from(activityLogs);
  if (Number(countResult[0].count) === 0) {
    await seedActivityLogs(db);
  }
}

export function registerRoutes(router: IAppRouter, basePath: string) {
  // GET /api/lakebase-examples/drizzle/activity - List activity logs
  router.get(`${basePath}/activity`, async (_req, res) => {
    try {
      const logs = await db
        .select()
        .from(activityLogs)
        .orderBy(desc(activityLogs.timestamp))
        .limit(50);
      res.json(logs);
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to fetch activity logs",
        message: err.message,
      });
    }
  });

  // POST /api/lakebase-examples/drizzle/activity - Create activity log
  router.post(`${basePath}/activity`, async (req, res) => {
    try {
      const { userId, action, metadata } = req.body;
      const [log] = await db
        .insert(activityLogs)
        .values({
          userId,
          action,
          metadata: metadata || null,
        })
        .returning();
      res.json(log);
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to create activity log",
        message: err.message,
      });
    }
  });

  // GET /api/lakebase-examples/drizzle/stats - Aggregated statistics
  router.get(`${basePath}/stats`, async (_req, res) => {
    try {
      // Total logs count
      const totalResult = await db
        .select({ count: count() })
        .from(activityLogs);

      // Unique users count
      const uniqueUsersResult = await db
        .select({
          count: sql<number>`COUNT(DISTINCT ${activityLogs.userId})`,
        })
        .from(activityLogs);

      // Recent activity (last 24 hours)
      const recentResult = await db
        .select({ count: count() })
        .from(activityLogs)
        .where(sql`${activityLogs.timestamp} > NOW() - INTERVAL '24 hours'`);

      res.json({
        totalLogs: Number(totalResult[0].count),
        uniqueUsers: Number(uniqueUsersResult[0].count),
        recentActivity: Number(recentResult[0].count),
      });
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to fetch statistics",
        message: err.message,
      });
    }
  });
}

export async function cleanup() {
  await pool.end();
}

async function seedActivityLogs(database: ReturnType<typeof drizzle>) {
  const users = ["alice", "bob", "charlie", "diana", "eve"];
  const actions = [
    "login",
    "logout",
    "view_dashboard",
    "create_report",
    "update_settings",
    "delete_item",
    "export_data",
    "share_document",
  ];

  const logs: NewActivityLog[] = [];

  // Generate 30 sample activity logs
  for (let i = 0; i < 30; i++) {
    const userId = users[Math.floor(Math.random() * users.length)];
    const action = actions[Math.floor(Math.random() * actions.length)];
    const metadata =
      Math.random() > 0.5
        ? {
            ip: `192.168.1.${Math.floor(Math.random() * 255)}`,
            userAgent: "Mozilla/5.0",
            duration: Math.floor(Math.random() * 5000),
          }
        : null;

    logs.push({
      userId,
      action,
      metadata,
    });
  }

  await database.insert(activityLogs).values(logs);
}
