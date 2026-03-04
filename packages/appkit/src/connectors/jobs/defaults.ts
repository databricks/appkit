export const jobsConnectorDefaults = {
  /** Run polling timeout in ms. 0 = indefinite. */
  timeout: 600_000,
  /** Max runs to return when listing. */
  maxRuns: 25,
} as const;
