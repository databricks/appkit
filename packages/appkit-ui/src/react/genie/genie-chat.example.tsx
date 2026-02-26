import { GenieChat } from "@databricks/appkit-ui/react";

export default function GenieChatExample() {
  return (
    <div style={{ height: 500, border: "1px solid #e2e8f0", borderRadius: 8 }}>
      <GenieChat alias="my-space" />
    </div>
  );
}
