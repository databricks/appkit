import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@databricks/appkit-ui/react"

export default function AvatarExample() {
  return (
    <Avatar>
      <AvatarImage src="https://github.com/shadcn.png" alt="@shadcn" />
      <AvatarFallback>CN</AvatarFallback>
    </Avatar>
  )
}
