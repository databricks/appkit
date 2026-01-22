"use client"

import * as React from "react"

import { LineChart } from "@databricks/appkit-ui/react"

export default function LineChartExample() {
  return (
    <LineChart
      data={[
        { month: "Jan", sales: 100 },
        { month: "Feb", sales: 150 },
        { month: "Mar", sales: 200 },
        { month: "Apr", sales: 180 },
        { month: "May", sales: 220 },
        { month: "Jun", sales: 250 },
      ]}
      xKey="month"
      yKey="sales"
      smooth
      height={300}
    />
  )
}
