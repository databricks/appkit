import { Terminal } from "lucide-react"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@databricks/appkit-ui/react"

export default function AlertExample() {
  return (
    <Alert>
      <Terminal className="h-4 w-4" />
      <AlertTitle>Example</AlertTitle>
      <AlertDescription>
        Lorem ipsum dolor sit amet, consectetur adipiscing elit.
      </AlertDescription>
    </Alert>
  )
}
