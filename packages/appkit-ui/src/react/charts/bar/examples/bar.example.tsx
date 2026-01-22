"use client"

import * as React from "react"

import { BarChart } from "@databricks/appkit-ui/react"

export default function BarChartExample() {
  return (
    <BarChart
      data={[
        { category: "Product A", value: 100 },
        { category: "Product B", value: 200 },
        { category: "Product C", value: 150 },
        { category: "Product D", value: 300 },
        { category: "Product E", value: 250 },
      ]}
      xKey="category"
      yKey="value"
      height={300}
    />
  )
}
