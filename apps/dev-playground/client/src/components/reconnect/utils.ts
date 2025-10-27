export function getStatusBadgeStyle(status: string): string {
  if (status.includes("Connected") && status !== "Reconnected") {
    return "bg-blue-100 text-blue-700 border-blue-200 hover:bg-blue-100 hover:text-blue-700";
  }
  if (status === "Reconnected") {
    return "bg-green-100 text-green-700 border-green-200 hover:bg-green-100 hover:text-green-700";
  }
  if (status.includes("Disconnected")) {
    return "bg-yellow-100 text-yellow-700 border-yellow-200 hover:bg-yellow-100 hover:text-yellow-700";
  }
  if (status === "Completed") {
    return "bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100 hover:text-emerald-700";
  }
  if (status === "Error") {
    return "bg-red-100 text-red-700 border-red-200 hover:bg-red-100 hover:text-red-700";
  }
  return "bg-gray-100 text-gray-700 border-gray-200 hover:bg-gray-100 hover:text-gray-700";
}

export function getTimelineSteps(status: string, messageCount: number) {
  return [
    {
      label: "Connected",
      active:
        status === "Connected" ||
        status === "Reconnected" ||
        status === "Completed",
      completed: messageCount >= 2,
    },
    {
      label: "Disconnected",
      active: status.includes("Disconnected"),
      completed: status === "Reconnected" || status === "Completed",
    },
    {
      label: "Reconnected",
      active: status === "Reconnected" || status === "Completed",
      completed: status === "Completed",
    },
    {
      label: "Completed",
      active: status === "Completed",
      completed: status === "Completed",
    },
  ];
}
