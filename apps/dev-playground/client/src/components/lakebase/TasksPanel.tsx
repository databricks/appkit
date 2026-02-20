import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Textarea,
} from "@databricks/appkit-ui/react";
import { CheckCircle, Circle, ListTodo, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import {
  useLakebaseData,
  useLakebasePatch,
  useLakebasePost,
} from "@/hooks/use-lakebase-data";

interface Task {
  id: number;
  title: string;
  status: "pending" | "in_progress" | "completed";
  description: string | null;
  createdAt: string;
}

interface TaskStats {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

export function TasksPanel() {
  const titleId = useId();
  const descriptionId = useId();

  const {
    data: tasks,
    loading: tasksLoading,
    error: tasksError,
    refetch,
  } = useLakebaseData<Task[]>("/api/lakebase-examples/typeorm/tasks");

  const { data: stats } = useLakebaseData<TaskStats>(
    "/api/lakebase-examples/typeorm/stats",
  );

  const { post, loading: creating } = useLakebasePost<Partial<Task>, Task>(
    "/api/lakebase-examples/typeorm/tasks",
  );

  const { patch, loading: updating } = useLakebasePatch<
    { status: string },
    Task
  >("/api/lakebase-examples/typeorm/tasks");

  const generateRandomTask = () => {
    const tasks = [
      {
        title: "Implement user authentication",
        description: "Add OAuth2 authentication flow with JWT tokens",
      },
      {
        title: "Write API documentation",
        description: "Document all REST endpoints with examples",
      },
      {
        title: "Set up CI/CD pipeline",
        description: "Configure GitHub Actions for automated testing",
      },
      {
        title: "Add error monitoring",
        description: "Integrate error tracking and alerting system",
      },
      {
        title: "Optimize database queries",
        description: "Add indexes and analyze slow queries",
      },
      {
        title: "Implement data validation",
        description: "Add schema validation for all API requests",
      },
      {
        title: "Set up development environment",
        description: "Configure local development tools and dependencies",
      },
      {
        title: "Design database schema",
        description: "Create ERD and define table relationships",
      },
    ];

    const task = tasks[Math.floor(Math.random() * tasks.length)];
    return {
      title: task.title,
      description: task.description,
    };
  };

  const [formData, setFormData] = useState(generateRandomTask());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await post({
      title: formData.title,
      description: formData.description || null,
      status: "pending",
    });

    if (result) {
      setFormData(generateRandomTask());
      refetch();
    }
  };

  const handleStatusUpdate = async (id: number, status: Task["status"]) => {
    const result = await patch(id, { status });
    if (result) {
      refetch();
    }
  };

  const getStatusBadge = (status: Task["status"]) => {
    switch (status) {
      case "pending":
        return (
          <Badge className="bg-gray-100 text-gray-700 border-gray-200">
            <Circle className="w-3 h-3 mr-1" />
            Pending
          </Badge>
        );
      case "in_progress":
        return (
          <Badge className="bg-blue-100 text-blue-700 border-blue-200">
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            In Progress
          </Badge>
        );
      case "completed":
        return (
          <Badge className="bg-green-100 text-green-700 border-green-200">
            <CheckCircle className="w-3 h-3 mr-1" />
            Completed
          </Badge>
        );
    }
  };

  const tasksByStatus = tasks
    ? {
        pending: tasks.filter((t) => t.status === "pending"),
        in_progress: tasks.filter((t) => t.status === "in_progress"),
        completed: tasks.filter((t) => t.status === "completed"),
      }
    : { pending: [], in_progress: [], completed: [] };

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card className="border-2">
        <CardHeader className="pb-0 gap-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-100 rounded-lg flex-shrink-0 self-start">
              <ListTodo className="h-6 w-6 text-green-600" />
            </div>
            <div className="flex-1 min-w-0">
              <CardTitle>TypeORM Example</CardTitle>
              <CardDescription>
                Entity-based data access with decorators and repository pattern
              </CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Statistics */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="text-xs">Total Tasks</CardDescription>
              <CardTitle className="text-2xl">{stats.total}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="text-xs">Pending</CardDescription>
              <CardTitle className="text-2xl">{stats.pending}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="text-xs">In Progress</CardDescription>
              <CardTitle className="text-2xl">{stats.inProgress}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardDescription className="text-xs">Completed</CardDescription>
              <CardTitle className="text-2xl">{stats.completed}</CardTitle>
            </CardHeader>
          </Card>
        </div>
      )}

      {/* Create task form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Create Task</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor={titleId}
                className="text-sm font-medium mb-1 block"
              >
                Task Title
              </label>
              <Input
                id={titleId}
                value={formData.title}
                onChange={(e) =>
                  setFormData({ ...formData, title: e.target.value })
                }
                placeholder="Implement feature X"
                required
              />
            </div>
            <div>
              <label
                htmlFor={descriptionId}
                className="text-sm font-medium mb-1 block"
              >
                Description (optional)
              </label>
              <Textarea
                id={descriptionId}
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                placeholder="Add detailed description..."
                rows={3}
              />
            </div>
            <Button type="submit" disabled={creating} className="w-full">
              {creating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Task"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Task board */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Task Board</CardTitle>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {tasksLoading && (
            <div className="flex items-center gap-2 text-warning py-8">
              <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
              Loading tasks...
            </div>
          )}

          {tasksError && (
            <div className="text-destructive bg-destructive/10 p-3 rounded-md border border-destructive/20">
              <span className="font-semibold">Error:</span> {tasksError.message}
            </div>
          )}

          {tasks && tasks.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <ListTodo className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>No tasks yet. Add a task to get started.</p>
            </div>
          )}

          {tasks && tasks.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Pending column */}
              <div className="space-y-3">
                <div className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                  Pending ({tasksByStatus.pending.length})
                </div>
                <div className="space-y-2">
                  {tasksByStatus.pending.map((task) => (
                    <Card key={task.id} className="p-3">
                      <div className="space-y-2">
                        <div>{getStatusBadge(task.status)}</div>
                        <h4 className="font-medium text-sm">{task.title}</h4>
                        {task.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            {task.description}
                          </p>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={() =>
                            handleStatusUpdate(task.id, "in_progress")
                          }
                          disabled={updating}
                        >
                          Start
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>

              {/* In Progress column */}
              <div className="space-y-3">
                <div className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                  In Progress ({tasksByStatus.in_progress.length})
                </div>
                <div className="space-y-2">
                  {tasksByStatus.in_progress.map((task) => (
                    <Card key={task.id} className="p-3">
                      <div className="space-y-2">
                        <div>{getStatusBadge(task.status)}</div>
                        <h4 className="font-medium text-sm">{task.title}</h4>
                        {task.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            {task.description}
                          </p>
                        )}
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="flex-1"
                            onClick={() =>
                              handleStatusUpdate(task.id, "pending")
                            }
                            disabled={updating}
                          >
                            Back
                          </Button>
                          <Button
                            size="sm"
                            className="flex-1"
                            onClick={() =>
                              handleStatusUpdate(task.id, "completed")
                            }
                            disabled={updating}
                          >
                            Complete
                          </Button>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>

              {/* Completed column */}
              <div className="space-y-3">
                <div className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                  Completed ({tasksByStatus.completed.length})
                </div>
                <div className="space-y-2">
                  {tasksByStatus.completed.map((task) => (
                    <Card key={task.id} className="p-3 opacity-75">
                      <div className="space-y-2">
                        <div>{getStatusBadge(task.status)}</div>
                        <h4 className="font-medium text-sm">{task.title}</h4>
                        {task.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            {task.description}
                          </p>
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
