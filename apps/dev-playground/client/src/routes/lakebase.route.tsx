import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@databricks/appkit-ui/react";
import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import {
  ActivityLogsPanel,
  OrdersPanel,
  ProductsPanel,
  TasksPanel,
} from "@/components/lakebase";

export const Route = createFileRoute("/lakebase")({
  component: LakebaseRoute,
  search: {
    middlewares: [retainSearchParams(true)],
  },
});

function LakebaseRoute() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-6 py-12">
        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Lakebase Examples</h1>
          <p className="text-base text-muted-foreground">
            Four approaches to PostgreSQL database integration with Databricks
            Lakebase. Compare raw driver, Drizzle ORM, TypeORM, and Sequelize
            side-by-side.
          </p>
        </div>

        {/* Tabs for different examples */}
        <Tabs defaultValue="raw" className="space-y-6">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="raw">Raw Driver</TabsTrigger>
            <TabsTrigger value="drizzle">Drizzle ORM</TabsTrigger>
            <TabsTrigger value="typeorm">TypeORM</TabsTrigger>
            <TabsTrigger value="sequelize">Sequelize</TabsTrigger>
          </TabsList>

          <TabsContent value="raw">
            <ProductsPanel />
          </TabsContent>

          <TabsContent value="drizzle">
            <ActivityLogsPanel />
          </TabsContent>

          <TabsContent value="typeorm">
            <TasksPanel />
          </TabsContent>

          <TabsContent value="sequelize">
            <OrdersPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
