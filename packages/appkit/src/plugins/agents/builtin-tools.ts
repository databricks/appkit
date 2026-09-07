import type { AgentToolDefinition } from "shared";

/** Built-in tool the model calls to load a skill's full instructions on demand. */
export const LOAD_SKILL_TOOL_DEF: AgentToolDefinition = {
  name: "load_skill",
  description:
    "Load the full instructions for one of the available skills by name. Call this before acting on a task that matches a skill's description. Returns the skill's instructions plus a list of any bundled files you can read with read_skill_file.",
  parameters: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description:
          "The exact skill name to load, as shown in the available-skills list.",
      },
    },
    required: ["skill"],
  },
  annotations: { effect: "read" },
};

/** Built-in tool for reading a resource file that a loaded skill references. */
export const READ_SKILL_FILE_TOOL_DEF: AgentToolDefinition = {
  name: "read_skill_file",
  description:
    "Read a bundled resource file that a loaded skill references (e.g. a reference doc). Only files listed by load_skill for that skill are readable.",
  parameters: {
    type: "object",
    properties: {
      skill: { type: "string", description: "The skill that owns the file." },
      path: {
        type: "string",
        description:
          "Relative path of the file within the skill, as listed by load_skill.",
      },
    },
    required: ["skill", "path"],
  },
  annotations: { effect: "read" },
};
