import { createLakebasePool, getLakebaseOrmConfig } from "@databricks/appkit";
import type { IAppRouter } from "shared";
import {
  Column,
  CreateDateColumn,
  DataSource,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

/**
 * TypeORM example with entity-based data access.
 *
 * This example demonstrates:
 * - Entity classes with decorators
 * - Repository pattern for data access
 * - OAuth token authentication with TypeORM
 * - CRUD operations with type safety
 * - Query builder capabilities
 */

@Entity({ schema: "typeorm_example", name: "tasks" })
class Task {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({
    type: "varchar",
    length: 50,
    default: "pending",
  })
  status!: "pending" | "in_progress" | "completed";

  @Column({ type: "text", nullable: true })
  description?: string;

  @CreateDateColumn({ name: "created_at", type: "timestamp" })
  createdAt!: Date;
}

let dataSource: DataSource;

export async function setup(user?: string) {
  // Create schema if not exists (TypeORM's synchronize doesn't create schemas)
  // See https://github.com/typeorm/typeorm/issues/3192
  const pool = createLakebasePool({ user });
  await pool.query("CREATE SCHEMA IF NOT EXISTS typeorm_example");
  await pool.end();

  dataSource = new DataSource({
    type: "postgres",
    ...getLakebaseOrmConfig({ user }),
    entities: [Task],
    synchronize: true,
    logging: false,
  });

  await dataSource.initialize();

  const taskRepo = dataSource.getRepository(Task);
  const count = await taskRepo.count();
  if (count === 0) {
    await seedTasks(taskRepo);
  }
}

export function registerRoutes(router: IAppRouter, basePath: string) {
  // GET /api/lakebase-examples/typeorm/tasks - List all tasks
  router.get(`${basePath}/tasks`, async (_req, res) => {
    try {
      const taskRepo = dataSource.getRepository(Task);
      const tasks = await taskRepo.find({ order: { createdAt: "DESC" } });
      res.json(tasks);
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to fetch tasks",
        message: err.message,
      });
    }
  });

  // POST /api/lakebase-examples/typeorm/tasks - Create new task
  router.post(`${basePath}/tasks`, async (req, res) => {
    try {
      const taskRepo = dataSource.getRepository(Task);
      const { title, description, status } = req.body;
      const task = taskRepo.create({
        title,
        description,
        status: status || "pending",
      });
      await taskRepo.save(task);
      res.json(task);
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to create task",
        message: err.message,
      });
    }
  });

  // PATCH /api/lakebase-examples/typeorm/tasks/:id - Update task status
  router.patch(`${basePath}/tasks/:id`, async (req, res) => {
    try {
      const taskRepo = dataSource.getRepository(Task);
      const { status } = req.body;
      await taskRepo.update(req.params.id, { status });
      const updated = await taskRepo.findOne({
        where: { id: Number(req.params.id) },
      });
      res.json(updated);
    } catch (error: unknown) {
      const err = error as Error;
      res.status(500).json({
        error: "Failed to update task",
        message: err.message,
      });
    }
  });

  // GET /api/lakebase-examples/typeorm/stats - Task statistics
  router.get(`${basePath}/stats`, async (_req, res) => {
    try {
      const taskRepo = dataSource.getRepository(Task);
      const [total, pending, inProgress, completed] = await Promise.all([
        taskRepo.count(),
        taskRepo.count({ where: { status: "pending" } }),
        taskRepo.count({ where: { status: "in_progress" } }),
        taskRepo.count({ where: { status: "completed" } }),
      ]);
      res.json({ total, pending, inProgress, completed });
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
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
}

async function seedTasks(repo: any) {
  const tasks = [
    {
      title: "Set up development environment",
      description: "Install Node.js, pnpm, and configure IDE",
      status: "completed" as const,
    },
    {
      title: "Implement user authentication",
      description: "Add OAuth2 authentication flow with JWT tokens",
      status: "in_progress" as const,
    },
    {
      title: "Design database schema",
      description: "Create ERD and define table relationships",
      status: "completed" as const,
    },
    {
      title: "Write API documentation",
      description: "Document all REST endpoints with examples",
      status: "pending" as const,
    },
    {
      title: "Implement data validation",
      description: "Add Zod schemas for request validation",
      status: "in_progress" as const,
    },
    {
      title: "Set up CI/CD pipeline",
      description: "Configure GitHub Actions for automated testing",
      status: "pending" as const,
    },
    {
      title: "Add error monitoring",
      description: "Integrate Sentry for error tracking",
      status: "pending" as const,
    },
    {
      title: "Optimize database queries",
      description: "Add indexes and analyze slow queries",
      status: "pending" as const,
    },
  ];

  for (const taskData of tasks) {
    const task = repo.create(taskData);
    await repo.save(task);
  }
}
