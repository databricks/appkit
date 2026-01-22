"use client"

import * as React from "react"

import { DonutChart } from "@databricks/appkit-ui/react"

export default function DonutChartExample() {
  return (
    <DonutChart
      data={[
        { name: "Engineering", value: 450 },
        { name: "Marketing", value: 250 },
        { name: "Sales", value: 300 },
        { name: "Operations", value: 200 },
      ]}
      height={300}
    />
  )
}
