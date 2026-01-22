import { Bold } from "lucide-react"

import { Toggle } from "@databricks/appkit-ui/react"

export default function ToggleExample() {
  return (
    <Toggle aria-label="Toggle bold">
      <Bold className="h-4 w-4" />
    </Toggle>
  )
}
