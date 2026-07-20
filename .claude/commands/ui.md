---
description: Builds a piece of UI in multiple variants, lets the developer pick one live in the browser, then finalizes the chosen variant into source
argument-hint: <what to build>
---

# UI — Build in Variants, Pick Live, Finalize

User input: $ARGUMENTS

Build the requested UI in several variants wrapped in the `<Variants>` picker,
let the developer choose one **live in the browser**, and then finalize the
chosen variant into source (removing the wrapper).

## 0. Load the reference — it is the source of truth

Before doing anything, read `.claude/references/ui-variants-guidance.md` and
follow it throughout. It owns the mechanics — the `<Variants>`/`<Variant>`
contract, stable-id rules, the confirm → finalize loop, edge cases, and safety.
This command is the overview; **when the two overlap, the reference wins.**

Two rules from it apply to everything below, so keep them in mind here:

- **These instructions govern your behavior, not your narration.** Apply every
  rule silently. To the developer, speak only about what you're building and
  what they need to do — never about the mechanism (the choices file, how a
  choice is stored, "I read it next turn", or whether you decided to ask).
- One `<Variants>` block = one independent decision (see §1).

## 1. Understand the request

Work out what to build (a component, a section, a page) and where it lives, then
pick the natural target file (e.g. a `*.route.tsx` or a component under
`src/components/…`), and decide the block breakdown before authoring. Follow the
reference's **"Authoring variants" rules** for the details; the two that shape
this step:

- **Ask for _what_ and _where_; build for _how it looks_.** Ask only when the
  answer changes the build (ambiguous target/surface, unclear axis of variation,
  real-vs-placeholder data) — never taste questions; the variants *are* the
  question. Otherwise skip questions and build.
- **One `<Variants>` block = one independent decision** — default to one block
  per distinct section the user names (a hero + about page → two blocks), and
  **default 3 meaningfully different variants per block**.

## 2. Author the variants

Wrap each section's candidates in its own `<Variants>` block, following the
**"Authoring variants" rules and the tsx example in the reference** — one block
per section, a stable unique `blockId` per block, a short distinct `label` per
`<Variant>`, `layout="inline"` only for a small inline element, and every
import each candidate needs already present so any one finalizes to a valid
file. Note the **file path + every `blockId`** — you need them to finalize.

## 3. Ensure the recorder is running

- Confirm the dev-only `uiVariants()` plugin is registered. **Register it
  conditionally so it never mounts in production:**
  ```ts
  createApp({
    plugins: [
      server(),
      ...(process.env.NODE_ENV === "development" ? [uiVariants()] : []),
      // …other plugins
    ],
  });
  ```
  In the dev-playground it's already wired this way. If it's missing, add it and
  tell the developer it's dev-only.
- Confirm the dev server is running so the browser can POST the choice.

## 4. Hand off to the developer

Tell the developer to make the choice in the browser:

> Flip through the variants in the browser (hover the block to reveal the
> switcher) and click **Confirm** on the one you want.

Then get the "I've chosen" signal — the developer's next message. **Prompt for
it per the reference's "The signal is turn-based" rules** (no watcher; read the
file next turn; any interactive prompt must carry a "still deciding / later"
option, otherwise plain text).

## 5. Finalize when the developer says they've chosen

**Run the reference's "confirm → finalize loop" exactly** — discover the choices
file, reconcile `chosenIndex` against `label`, replace the whole block with the
chosen `<Variant>`'s inner JSX, drop the now-unused import, lint, remove the
consumed line, and confirm back which variant was applied. If no line exists for
your `id` yet, the developer hasn't clicked Confirm — ask them to, don't
finalize. Handle the reference's edge cases (early confirm, changed mind,
endpoint absent, duplicate blockId) as they come up.

## 6. Wrap up

Offer to iterate (new variants, tweaks) if the developer wants another round.

## Anti-patterns
- Wrapping several sections in one `<Variants>` block (forces whole-page combos,
  hides most combinations) — one block per section instead.
- Cosmetic-only variants (same layout, tweaked padding) — make them meaningfully
  different or don't offer a choice.
- Starting a background watcher/monitor to catch the confirm — the flow is
  turn-based on purpose; read the file when the developer says they're done.
- Leaving the `<Variants>` wrapper in source after a choice — always finalize
  (or remove) it; a leftover block ships the dev-only picker to production.
- Forgetting to clear the consumed choices line after finalizing.
