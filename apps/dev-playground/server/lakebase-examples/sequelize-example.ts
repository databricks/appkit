import { getLakebaseOrmConfig } from "@databricks/appkit";
import { DataTypes, Model, Sequelize } from "sequelize";
import type { IAppRouter } from "shared";

/**
 * Sequelize example with model-based data access.
 *
 * This example demonstrates:
 * - Model definitions with DataTypes
 * - Standard ORM operations (CRUD)
 * - OAuth token authentication with Sequelize
 * - Type-safe queries with TypeScript
 * - Automatic timestamps
 */

interface OrderAttributes {
  id: number;
  orderNumber: string;
  customerName: string;
  productName: string;
  amount: number;
  status: "pending" | "processing" | "shipped" | "delivered";
  createdAt: Date;
  updatedAt: Date;
}

interface OrderCreationAttributes
  extends Omit<OrderAttributes, "id" | "createdAt" | "updatedAt"> {}

class Order
  extends Model<OrderAttributes, OrderCreationAttributes>
  implements OrderAttributes
{
  declare id: number;
  declare orderNumber: string;
  declare customerName: string;
  declare productName: string;
  declare amount: number;
  declare status: "pending" | "processing" | "shipped" | "delivered";
  declare createdAt: Date;
  declare updatedAt: Date;
}

let sequelize: Sequelize;

export async function setup() {
  // @ts-expect-error password property supports a function for Lakehouse OAuth tokens
  sequelize = new Sequelize({
    dialect: "postgres",
    ...getLakebaseOrmConfig(),
    logging: false,
  });

  // Create schema if not exists
  await sequelize.query("CREATE SCHEMA IF NOT EXISTS sequelize_example");

  // Define Order model
  Order.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      orderNumber: {
        type: DataTypes.STRING(50),
        allowNull: false,
        field: "order_number",
      },
      customerName: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: "customer_name",
      },
      productName: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: "product_name",
      },
      amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      status: {
        type: DataTypes.STRING(50),
        allowNull: false,
        defaultValue: "pending",
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: "created_at",
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        field: "updated_at",
      },
    },
    {
      sequelize,
      schema: "sequelize_example",
      tableName: "orders",
      timestamps: true,
      underscored: true,
    },
  );

  // Sync model (create table if not exists)
  await Order.sync();

  // Seed data if table is empty
  const count = await Order.count();
  if (count === 0) {
    await seedOrders();
  }
}

export function registerRoutes(router: IAppRouter, basePath: string) {
  // GET /api/lakebase-examples/sequelize/orders - List all orders
  router.get(`${basePath}/orders`, async (_req, res) => {
    try {
      const orders = await Order.findAll({
        order: [["createdAt", "DESC"]],
      });
      res.json(orders);
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to fetch orders",
        message: err.message,
      });
    }
  });

  // POST /api/lakebase-examples/sequelize/orders - Create new order
  router.post(`${basePath}/orders`, async (req, res) => {
    try {
      const { orderNumber, customerName, productName, amount, status } =
        req.body;
      const order = await Order.create({
        orderNumber,
        customerName,
        productName,
        amount,
        status: status || "pending",
      });
      res.json(order);
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to create order",
        message: err.message,
      });
    }
  });

  // PATCH /api/lakebase-examples/sequelize/orders/:id - Update order status
  router.patch(`${basePath}/orders/:id`, async (req, res) => {
    try {
      const { status } = req.body;
      const order = await Order.findByPk(req.params.id);

      if (!order) {
        res.status(404).json({
          error: "Order not found",
          message: `Order with id ${req.params.id} does not exist`,
        });
        return;
      }

      order.status = status;
      await order.save();
      res.json(order);
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to update order",
        message: err.message,
      });
    }
  });

  // GET /api/lakebase-examples/sequelize/stats - Order statistics
  router.get(`${basePath}/stats`, async (_req, res) => {
    try {
      const [total, pending, processing, shipped, delivered] =
        await Promise.all([
          Order.count(),
          Order.count({ where: { status: "pending" } }),
          Order.count({ where: { status: "processing" } }),
          Order.count({ where: { status: "shipped" } }),
          Order.count({ where: { status: "delivered" } }),
        ]);
      res.json({ total, pending, processing, shipped, delivered });
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
  if (sequelize) {
    await sequelize.close();
  }
}

async function seedOrders() {
  const orders = [
    {
      orderNumber: "ORD-2024-001",
      customerName: "Alice Johnson",
      productName: "Wireless Bluetooth Headphones",
      amount: 89.99,
      status: "delivered" as const,
    },
    {
      orderNumber: "ORD-2024-002",
      customerName: "Bob Smith",
      productName: "USB-C Charging Cable",
      amount: 15.99,
      status: "delivered" as const,
    },
    {
      orderNumber: "ORD-2024-003",
      customerName: "Carol Williams",
      productName: "Laptop Stand - Ergonomic",
      amount: 45.5,
      status: "shipped" as const,
    },
    {
      orderNumber: "ORD-2024-004",
      customerName: "David Brown",
      productName: "Mechanical Keyboard - RGB",
      amount: 129.99,
      status: "processing" as const,
    },
    {
      orderNumber: "ORD-2024-005",
      customerName: "Emma Davis",
      productName: "4K Webcam with Microphone",
      amount: 79.99,
      status: "processing" as const,
    },
    {
      orderNumber: "ORD-2024-006",
      customerName: "Frank Miller",
      productName: "Portable SSD 1TB",
      amount: 149.99,
      status: "pending" as const,
    },
    {
      orderNumber: "ORD-2024-007",
      customerName: "Grace Wilson",
      productName: "Wireless Mouse - Ergonomic",
      amount: 34.99,
      status: "pending" as const,
    },
    {
      orderNumber: "ORD-2024-008",
      customerName: "Henry Moore",
      productName: "Monitor Arm Mount",
      amount: 59.99,
      status: "pending" as const,
    },
  ];

  await Order.bulkCreate(orders);
}
