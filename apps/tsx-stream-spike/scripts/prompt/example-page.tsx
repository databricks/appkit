// Example design page: a sales overview. Data comes from ../mock (shared by all drafts).
import {
  Badge,
  BarChart,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  LineChart,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@databricks/appkit-ui/react";
import { DollarSign, Download, TrendingUp, Users } from "lucide-react";
import { useState } from "react";

import { kpis, monthlyRevenue, regions, topDeals } from "../mock";

const icons = { revenue: DollarSign, customers: Users, growth: TrendingUp };

export default function SalesOverview() {
  const [region, setRegion] = useState("all");
  const deals =
    region === "all" ? topDeals : topDeals.filter((d) => d.region === region);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Sales overview
          </h1>
          <p className="text-sm text-muted-foreground">
            Last 12 months, all channels
          </p>
        </div>
        <Button variant="outline" size="sm">
          <Download /> Export
        </Button>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        {kpis.map((k) => {
          const Icon = icons[k.id];
          return (
            <Card key={k.id}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardDescription>{k.label}</CardDescription>
                <Icon className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-semibold tabular-nums">
                  {k.value}
                </div>
                <p
                  className={
                    k.delta >= 0
                      ? "text-xs text-success"
                      : "text-xs text-destructive"
                  }
                >
                  {k.delta >= 0 ? "+" : ""}
                  {k.delta}% vs last period
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Tabs defaultValue="trend">
        <TabsList>
          <TabsTrigger value="trend">Trend</TabsTrigger>
          <TabsTrigger value="regions">By region</TabsTrigger>
        </TabsList>
        <TabsContent value="trend">
          <Card>
            <CardContent>
              <LineChart
                data={monthlyRevenue}
                xKey="month"
                yKey={["revenue", "target"]}
                height={280}
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="regions">
          <Card>
            <CardContent>
              <BarChart
                data={regions}
                xKey="region"
                yKey="revenue"
                height={280}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle>Top deals</CardTitle>
          <div className="flex gap-2">
            {["all", ...regions.map((r) => r.region)].map((r) => (
              <Badge
                key={r}
                variant={region === r ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => setRegion(r)}
              >
                {r}
              </Badge>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Region</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deals.map((d) => (
                <TableRow key={d.account}>
                  <TableCell className="font-medium">{d.account}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {d.region}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    ${d.amount.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
