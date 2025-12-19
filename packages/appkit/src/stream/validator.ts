export class StreamValidator {
  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private static readonly STREAM_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

  // validates eventId format and throws on invalid input
  static validateEventId(eventId?: string | string[]): boolean {
    if (!eventId || typeof eventId !== "string" || eventId.length !== 36) {
      return false;
    }

    return StreamValidator.UUID_REGEX.test(eventId);
  }

  // validates streamId format and throws on invalid input
  static validateStreamId(streamId?: string): boolean {
    if (!streamId || streamId.length === 0 || streamId.length > 256) {
      return false;
    }

    if (!StreamValidator.STREAM_ID_REGEX.test(streamId)) {
      return false;
    }
    return true;
  }

  // sanitizes event type for SSE format
  static sanitizeEventType(type: string): string {
    return (type || "message").replace(/[\r\n]/g, "").slice(0, 100);
  }
}
