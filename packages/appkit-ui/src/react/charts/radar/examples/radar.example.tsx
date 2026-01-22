"use client"

import * as React from "react"

import { RadarChart } from "@databricks/appkit-ui/react"

export default function RadarChartExample() {
  return (
    <RadarChart
      data={[
        { skill: "Communication", score: 85 },
        { skill: "Problem Solving", score: 90 },
        { skill: "Teamwork", score: 75 },
        { skill: "Leadership", score: 80 },
        { skill: "Technical", score: 95 },
        { skill: "Creativity", score: 70 },
      ]}
      xKey="skill"
      yKey="score"
      height={300}
    />
  )
}
