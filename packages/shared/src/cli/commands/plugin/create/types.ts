/**
 * Types for plugin create CLI answers and scaffold input.
 */

export type Placement = "in-repo" | "isolated";

/** A resource selected by the user (full spec from prompts, shared with add-resource). */
export interface SelectedResource {
  type: string;
  required: boolean;
  description: string;
  resourceKey: string;
  permission: string;
  fields: Record<string, { env: string; description?: string }>;
}

/** Collected answers from prompts. */
export interface CreateAnswers {
  placement: Placement;
  /** For in-repo: folder path (e.g. plugins/my-plugin). For isolated: directory name (e.g. appkit-plugin-my-feature). */
  targetPath: string;
  name: string;
  displayName: string;
  description: string;
  resources: SelectedResource[];
  author?: string;
  version: string;
  license?: string;
}
