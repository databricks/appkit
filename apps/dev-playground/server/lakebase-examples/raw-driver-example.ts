import {
  createLakebasePool,
  createLakebasePoolManager,
  type LakebasePoolManager,
} from "@databricks/appkit";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import type { Pool } from "pg";
import type { IAppRouter } from "shared";

let pool: Pool;
let oboPoolManager: LakebasePoolManager;

/**
 * Raw PostgreSQL driver example using pg.Pool with automatic OAuth token refresh.
 *
 * This example demonstrates:
 * - Direct pg.Pool usage without ORM abstraction
 * - Manual SQL query writing with parameterized queries
 * - Schema and table creation (idempotent)
 * - Basic CRUD operations
 * - Connection health checking
 * - On-Behalf-Of (OBO) authentication with per-user pools
 * - Row-Level Security (RLS) enforcement via OBO
 */

interface Product {
  id: number;
  name: string;
  category: string;
  price: number;
  stock: number;
  created_by: string | null;
  created_at: Date;
}

export async function setup(user?: string) {
  // Create service principal pool with automatic OAuth token refresh
  pool = createLakebasePool({ user });

  // Create OBO pool manager for per-user pools
  oboPoolManager = createLakebasePoolManager();

  // Create schema and table (idempotent)
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS raw_example;

    CREATE TABLE IF NOT EXISTS raw_example.products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100),
      price DECIMAL(10, 2),
      stock INTEGER DEFAULT 0,
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Enable Row-Level Security (idempotent)
  await pool.query(`
    ALTER TABLE raw_example.products ENABLE ROW LEVEL SECURITY;
  `);

  // Create RLS policy (idempotent via IF NOT EXISTS-like pattern)
  // Users see only rows they created (or rows with NULL created_by for seed data).
  // The table owner (service principal) bypasses RLS automatically.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'raw_example'
          AND tablename = 'products'
          AND policyname = 'user_products_policy'
      ) THEN
        CREATE POLICY user_products_policy ON raw_example.products
          FOR ALL TO PUBLIC
          USING (created_by = current_user OR created_by IS NULL);
      END IF;
    END
    $$;
  `);

  // Seed sample data if table is empty
  const { rows } = await pool.query<{ count: string }>(
    "SELECT COUNT(*) as count FROM raw_example.products",
  );
  if (Number(rows[0].count) === 0) {
    await seedProducts(pool);
  }
}

/**
 * Get a per-user pool from the OBO pool manager.
 * Falls back to the service principal pool in development when no user token is available.
 */
function getUserPool(
  req: { header(name: string): string | undefined },
  fallbackPool: Pool,
): { pool: Pool; userName: string | null } {
  const userToken = req.header("x-forwarded-access-token");
  const userName = req.header("x-forwarded-user");

  if (!userToken || !userName) {
    console.log("[lakebase-obo] No user token/name — falling back to SP pool");
    return { pool: fallbackPool, userName: null };
  }

  const isNewPool = !oboPoolManager.hasPool(userName);
  const userPool = oboPoolManager.getPool(userName, {
    workspaceClient: new WorkspaceClient({
      token: userToken,
      host: process.env.DATABRICKS_HOST,
      authType: "pat",
    }),
    user: userName,
  });

  if (isNewPool) {
    console.log(
      `[lakebase-obo] Created new OBO pool for user "${userName}" (total pools: ${oboPoolManager.size})`,
    );
  } else {
    console.log(`[lakebase-obo] Reusing OBO pool for user "${userName}"`);
  }

  return { pool: userPool, userName };
}

export function registerRoutes(router: IAppRouter, basePath: string) {
  // ── Service principal routes (bypass RLS as table owner) ──────────

  // GET /raw/products - List ALL products (SP pool, bypasses RLS)
  router.get(`${basePath}/products`, async (_req, res) => {
    try {
      const result = await pool.query<Product>(
        "SELECT * FROM raw_example.products ORDER BY id",
      );
      res.json(result.rows);
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to fetch products",
        message: err.message,
      });
    }
  });

  // POST /raw/products - Create product as SP (no created_by)
  router.post(`${basePath}/products`, async (req, res) => {
    try {
      const { name, category, price, stock } = req.body;

      const result = await pool.query<Product>(
        `INSERT INTO raw_example.products (name, category, price, stock)
           VALUES ($1, $2, $3, $4) RETURNING *`,
        [name, category, Number(price), Number(stock)],
      );
      res.json(result.rows[0]);
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to create product",
        message: err.message,
      });
    }
  });

  // GET /raw/health - Connection health check
  router.get(`${basePath}/health`, async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({
        status: "healthy",
        connected: true,
        message: "Connection to Lakebase is active",
      });
    } catch (error: unknown) {
      const err = error as Error;
      res.status(503).json({
        status: "unhealthy",
        connected: false,
        message: err.message,
      });
    }
  });

  // ── OBO routes (per-user pool, RLS enforced) ─────────────────────

  // GET /raw/my-products - List products visible to the current user (RLS-filtered)
  router.get(`${basePath}/my-products`, async (req, res) => {
    try {
      const { pool: userPool, userName } = getUserPool(req, pool);
      const result = await userPool.query<Product>(
        "SELECT * FROM raw_example.products ORDER BY id",
      );
      res.json({
        user: userName ?? "service-principal (dev fallback)",
        products: result.rows,
      });
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to fetch user products",
        message: err.message,
      });
    }
  });

  // POST /raw/my-products - Create product as current user (sets created_by)
  router.post(`${basePath}/my-products`, async (req, res) => {
    try {
      const { pool: userPool, userName } = getUserPool(req, pool);
      const { name, category, price, stock } = req.body;

      const result = await userPool.query<Product>(
        `INSERT INTO raw_example.products (name, category, price, stock, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, category, Number(price), Number(stock), userName],
      );
      res.json(result.rows[0]);
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to create product",
        message: err.message,
      });
    }
  });
}

export async function cleanup() {
  await Promise.all([pool.end(), oboPoolManager.closeAll()]);
}

async function seedProducts(pool: Pool) {
  const products = [
    {
      name: "Wireless Mouse",
      category: "Electronics",
      price: 29.99,
      stock: 150,
    },
    {
      name: "Mechanical Keyboard",
      category: "Electronics",
      price: 89.99,
      stock: 75,
    },
    {
      name: "USB-C Hub",
      category: "Electronics",
      price: 49.99,
      stock: 200,
    },
    {
      name: "The Pragmatic Programmer",
      category: "Books",
      price: 39.99,
      stock: 50,
    },
    {
      name: "Clean Code",
      category: "Books",
      price: 42.99,
      stock: 60,
    },
    {
      name: "Cotton T-Shirt",
      category: "Clothing",
      price: 19.99,
      stock: 300,
    },
    {
      name: "Denim Jeans",
      category: "Clothing",
      price: 59.99,
      stock: 120,
    },
    {
      name: "Running Shoes",
      category: "Clothing",
      price: 79.99,
      stock: 85,
    },
  ];

  for (const product of products) {
    await pool.query(
      `INSERT INTO raw_example.products (name, category, price, stock)
       VALUES ($1, $2, $3, $4)`,
      [product.name, product.category, product.price, product.stock],
    );
  }
}
