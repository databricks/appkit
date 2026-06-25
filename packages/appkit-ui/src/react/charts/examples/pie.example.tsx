"use client";

import { PieChart } from "@databricks/appkit-ui/react";

export default function PieChartExample() {
  return (
    <PieChart
      data={[
        { name: "Product A", value: 400 },
        { name: "Product B", value: 300 },
        { name: "Product C", value: 300 },
        { name: "Product D", value: 200 },
      ]}
      height={300}
    />
  );
}
