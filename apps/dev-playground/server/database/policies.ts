import { definePolicy, type PolicyContext } from "@databricks/appkit/beta";

/**
 * Any signed-in user. AppKit verifies the caller with the workspace before a
 * policy runs and answers 401 without one, so reaching this rule is the check.
 */
export const signedIn = definePolicy({ allow: () => true });

/**
 * Loads the note named by `input.id` and admits only its author. Notes are
 * readable by every signed-in user, so a refusal is a 403 rather than a 404.
 */
export const noteAuthor = definePolicy({
  resource: ({ db, input }: PolicyContext<{ readonly id: number }>) =>
    db.notes.find(input.id),
  allow: ({ actor, resource }) =>
    resource.author === actor.id ? true : { deny: "forbidden" },
});
