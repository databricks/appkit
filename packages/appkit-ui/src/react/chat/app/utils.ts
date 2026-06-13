import type { UIMessage } from "ai";

/** Concatenate the text of all `text` parts in a message. */
export function getMessageText<TMessage extends UIMessage>(
  message: TMessage,
): string {
  return (message.parts as Array<{ type: string; text?: unknown }>)
    .filter((p) => p.type === "text")
    .map((p) => String(p.text ?? ""))
    .join("");
}
