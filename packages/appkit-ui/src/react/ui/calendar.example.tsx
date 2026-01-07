"use client"

import * as React from "react"

import { Calendar } from "./calendar"

export default function CalendarExample() {
  const [date, setDate] = React.useState<Date | undefined>(new Date())

  return (
    <Calendar
      mode="single"
      selected={date}
      onSelect={setDate}
      className="rounded-md border"
    />
  )
}
