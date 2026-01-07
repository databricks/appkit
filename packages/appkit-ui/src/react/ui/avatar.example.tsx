import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "./avatar"

export default function AvatarExample() {
  return (
    <Avatar>
      <AvatarImage src="https://github.com/shadcn.png" alt="@shadcn" />
      <AvatarFallback>CN</AvatarFallback>
    </Avatar>
  )
}
