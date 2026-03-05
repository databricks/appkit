export const genieConnectorDefaults = {
  /** Genie waiter timeout in ms. 0 = indefinite. */
  timeout: 120_000,
  /** Max messages to fetch when listing a conversation. */
  maxMessages: 200,
  /** Default page size for listConversationMessages. */
  pageSize: 100,
  /** Default page size for initial conversation load (lazy loading). */
  initialPageSize: 20,
} as const;
