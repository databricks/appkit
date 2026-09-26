/**
 * Browser binding target for the application's generated database registry.
 * Empty by default; the generated `shared/appkit-types/database.d.ts` binds the
 * same entries it binds into `@databricks/appkit`:
 *
 * @example
 * ```typescript
 * declare module "@databricks/appkit-ui/js/beta" {
 *   interface DatabaseRegistry extends GeneratedDatabaseRegistry {}
 * }
 * ```
 */
// oxlint-disable-next-line typescript/no-empty-object-type -- augmentation target, populated by typegen.
export interface DatabaseRegistry {}
