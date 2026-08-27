import type { Schema } from "../../database/schema-builder";

/** Configuration for one schema-bound DatabasePlugin instance. */
export type IDatabaseConfig<TSchema extends Schema> = {
  readonly schema: TSchema;
};
