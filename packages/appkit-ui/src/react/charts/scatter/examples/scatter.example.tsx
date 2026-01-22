"use client"

import * as React from "react"

import { ScatterChart } from "@databricks/appkit-ui/react"

export default function ScatterChartExample() {
  return (
    <ScatterChart
      data={[
        { revenue: 100, growth: 5 },
        { revenue: 200, growth: 10 },
        { revenue: 150, growth: 7 },
        { revenue: 300, growth: 15 },
        { revenue: 250, growth: 12 },
        { revenue: 400, growth: 20 },
        { revenue: 180, growth: 8 },
        { revenue: 320, growth: 16 },
      ]}
      xKey="revenue"
      yKey="growth"
      height={300}
    />
  )
}
