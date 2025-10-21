/** biome-ignore-all lint/complexity/noStaticOnlyClass: this is a static class */

export class StreamValidator {
  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private static readonly STREAM_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

  // validates UUID format with ReDos protection
  static isValidUUID(uuid: string): boolean {
    if (!uuid || uuid.length !== 36) {
      return false;
    }

    return StreamValidator.UUID_REGEX.test(uuid);
  }

  // validates streamId format and throws on invalid input
  static validateStreamId(streamId?: string): void {
    if (!streamId || streamId.length === 0 || streamId.length > 256) {
      throw new Error(
        "invalid streamId: must be a string up to 256 characters",
      );
    }

    if (!StreamValidator.STREAM_ID_REGEX.test(streamId)) {
      throw new Error(
        "invalid streamId: must contain only alphanumeric characters, hyphens, and underscores",
      );
    }
  }

  // sanitizes event type for SSE format
  static sanitizeEventType(type: string): string {
    return (type || "message").replace(/[\r\n]/g, "").slice(0, 100);
  }
}
