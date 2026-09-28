/**
 * Browser binding target for the application's generated database registry.
 * The generated database.d.ts extends the global bridge without importing UI,
 * so apps using only the server package can typecheck independently.
 */
declare global {
  // oxlint-disable-next-line typescript/no-empty-object-type -- populated by typegen.
  interface DatabricksAppKitDatabaseRegistry {}
}

// oxlint-disable-next-line typescript/no-empty-object-type -- application registry.
export interface DatabaseRegistry extends DatabricksAppKitDatabaseRegistry {}
