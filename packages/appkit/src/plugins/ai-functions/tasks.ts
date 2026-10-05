import type {
  AiFunctionTaskAuth,
  ClassifyRequest,
  DecideRequest,
  ExtractRequest,
} from "shared";

import { AiFunctionsRequestError } from "./errors";
import {
  parseClassifyRequest,
  parseDecideRequest,
  parseExtractRequest,
} from "./schemas";

export type { AiFunctionName } from "shared";

/** Task names are safe in URLs and agent tool names. */
export const TASK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const MAX_DESCRIPTION_CHARS = 1000;
/** Stands in for the input while a task's request template is validated. */
const PLACEHOLDER_INPUT = "x";

export type PreparedTask =
  | {
      function: "classify";
      auth: AiFunctionTaskAuth;
      description?: string;
      template: ClassifyRequest;
    }
  | {
      function: "extract";
      auth: AiFunctionTaskAuth;
      description?: string;
      template: ExtractRequest;
    }
  | {
      function: "decide";
      auth: AiFunctionTaskAuth;
      description?: string;
      template: DecideRequest;
    };

/** A task definition failed validation. The message never contains labels, keys, or content. */
export class TaskDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskDefinitionError";
  }
}

/**
 * Validates a task definition with the same parsers as direct calls, and
 * returns its parsed request template (version pinned, placeholder input).
 */
export function prepareTask(task: unknown): PreparedTask {
  if (typeof task !== "object" || task === null || Array.isArray(task)) {
    throw new TaskDefinitionError("task must be an object");
  }
  const {
    function: fn,
    auth,
    description,
    ...request
  } = task as Record<string, unknown>;
  if (fn !== "classify" && fn !== "extract" && fn !== "decide") {
    throw new TaskDefinitionError(
      'function must be "classify", "extract", or "decide"',
    );
  }
  if (
    auth !== undefined &&
    auth !== "service-principal" &&
    auth !== "on-behalf-of-user"
  ) {
    throw new TaskDefinitionError(
      'auth must be "service-principal" or "on-behalf-of-user"',
    );
  }
  const inputField = fn === "decide" ? "state" : "content";
  if (inputField in request) {
    const article = fn === "extract" ? "an" : "a";
    throw new TaskDefinitionError(
      `${article} ${fn} task must not include ${inputField}`,
    );
  }

  const common = {
    auth: auth ?? "service-principal",
    ...(description !== undefined ? { description } : {}),
  } as { auth: AiFunctionTaskAuth; description?: string };

  let prepared: PreparedTask;
  try {
    switch (fn) {
      case "classify":
        prepared = {
          function: fn,
          ...common,
          template: parseClassifyRequest({
            ...request,
            content: PLACEHOLDER_INPUT,
          }),
        };
        break;
      case "extract":
        prepared = {
          function: fn,
          ...common,
          template: parseExtractRequest({
            ...request,
            content: PLACEHOLDER_INPUT,
          }),
        };
        break;
      case "decide":
        prepared = {
          function: fn,
          ...common,
          template: parseDecideRequest({
            ...request,
            state: PLACEHOLDER_INPUT,
          }),
        };
        break;
    }
  } catch (error) {
    if (error instanceof AiFunctionsRequestError) {
      throw new TaskDefinitionError(error.message);
    }
    throw error;
  }
  if (
    description !== undefined &&
    (typeof description !== "string" ||
      description.length < 1 ||
      description.length > MAX_DESCRIPTION_CHARS)
  ) {
    throw new TaskDefinitionError(
      `description must be a string of 1 to ${MAX_DESCRIPTION_CHARS} characters`,
    );
  }
  return prepared;
}
