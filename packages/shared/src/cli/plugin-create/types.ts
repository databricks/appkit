/**
 * Types for plugin create CLI answers and scaffold input.
 */

export type Placement = "in-repo" | "isolated";

/** A resource selected by the user (type + required/optional + description). */
export interface SelectedResource {
  type: string;
  required: boolean;
  description: string;
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
