import { createLakebasePool } from "@databricks/appkit";
import type { Pool } from "pg";
import type { IAppRouter } from "shared";

let pool: Pool;

/**
 * Raw PostgreSQL driver example using pg.Pool with automatic OAuth token refresh.
 *
 * This example demonstrates:
 * - Direct pg.Pool usage without ORM abstraction
 * - Manual SQL query writing with parameterized queries
 * - Schema and table creation (idempotent)
 * - Basic CRUD operations
 * - Connection health checking
 */

interface Product {
  id: number;
  name: string;
  category: string;
  price: number;
  stock: number;
  created_by?: string;
  created_at: Date;
}

export async function setup() {
  // Create pool with automatic OAuth token refresh
  pool = createLakebasePool();

  // Create schema and table (idempotent)
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS raw_example;

    CREATE TABLE IF NOT EXISTS raw_example.products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(100),
      price DECIMAL(10, 2),
      stock INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed sample data if table is empty
  const { rows } = await pool.query<{ count: string }>(
    "SELECT COUNT(*) as count FROM raw_example.products",
  );
  if (Number(rows[0].count) === 0) {
    await seedProducts(pool);
  }
}

export function registerRoutes(router: IAppRouter, basePath: string) {
  // GET /api/lakebase-examples/raw/products - List all products
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

  // POST /api/lakebase-examples/raw/products - Create new product
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

  // GET /api/lakebase-examples/raw/health - Connection health check
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
}

export async function cleanup() {
  await pool.end();
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
