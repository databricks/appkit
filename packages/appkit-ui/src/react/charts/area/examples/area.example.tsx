"use client"

import * as React from "react"

import { AreaChart } from "@databricks/appkit-ui/react"

export default function AreaChartExample() {
  return (
    <AreaChart
      data={[
        { month: "Jan", visitors: 1000, revenue: 5000 },
        { month: "Feb", visitors: 1500, revenue: 7000 },
        { month: "Mar", visitors: 2000, revenue: 9000 },
        { month: "Apr", visitors: 1800, revenue: 8500 },
        { month: "May", visitors: 2200, revenue: 10000 },
        { month: "Jun", visitors: 2500, revenue: 11000 },
      ]}
      xKey="month"
      yKey={["visitors", "revenue"]}
      stacked
      showLegend
      height={300}
    />
  )
}
