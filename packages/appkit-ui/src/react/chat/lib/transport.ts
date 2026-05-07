import {
  DefaultChatTransport,
  type HttpChatTransportInitOptions,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

/**
 * Transport extension that taps into the streamed UIMessageChunks before
 * they reach the SDK's reducer. Used by `useChat` to spot the
 * stream's first chunk (for history-revalidation timing) and the latest
 * chunk (for resume-on-disconnect heuristics) without re-parsing the
 * stream a second time.
 */
export class ChatTransport<
  T extends UIMessage,
> extends DefaultChatTransport<T> {
  private onStreamPart: ((part: UIMessageChunk) => void) | undefined;
  constructor(
    options?: HttpChatTransportInitOptions<T> & {
      onStreamPart?: (part: UIMessageChunk) => void;
    },
  ) {
    const { onStreamPart, ...rest } = options ?? {};
    super(rest);
    this.onStreamPart = onStreamPart;
  }

  protected processResponseStream(
    stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
  ): ReadableStream<UIMessageChunk> {
    const onStreamPart = this.onStreamPart;
    const processedStream = super.processResponseStream(stream);
    return processedStream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          onStreamPart?.(chunk);
          controller.enqueue(chunk);
        },
      }),
    );
  }
}
