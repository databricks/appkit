"use client"

import * as React from "react"

import { HeatmapChart } from "@databricks/appkit-ui/react"

export default function HeatmapChartExample() {
  const data = []
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  const hours = ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"]
  
  for (const day of days) {
    for (const hour of hours) {
      data.push({
        day,
        hour,
        count: Math.floor(Math.random() * 100),
      })
    }
  }

  return (
    <HeatmapChart
      data={data}
      xKey="day"
      yAxisKey="hour"
      yKey="count"
      height={300}
    />
  )
}
