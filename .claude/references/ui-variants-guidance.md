# App UI Variants — Reference

Rules for the `/ui` command and anyone maintaining the `<Variants>` picker. The
picker lets a developer choose between several candidate UIs live in the browser
during local dev; the agent then finalizes the chosen one into source.

**These rules govern the agent's behavior, not its narration.** Apply them
silently. To the developer, speak only about what's being built and what they
need to do — never about the mechanism (the choices file, how the choice is
stored, "read on the next turn", or whether questions were considered).

## Contents

- **The pieces** — `<Variants>`/`<Variant>`, the `uiVariants()` recorder, the choices file.
- **The signal is turn-based** — no watcher; how to prompt for the confirm.
- **Authoring variants (agent rules)** — when to ask, block granularity, ids, count, example.
- **The confirm → finalize loop** — discover the file, reconcile, replace, clean up.
- **Edge cases** — early confirm, mind changed, endpoint absent, duplicate blockId.
- **Keeping it out of production** — always finalize or remove every block.
- **Contract source** — where the file path and record shape are owned.

## The pieces

- **`<Variants>` / `<Variant>`** — `@databricks/appkit-ui/react`. A dev-time
  wrapper that renders one candidate at a time with a hover-revealed switcher
  (prev/next, an index pill + label) and a **Confirm** tick.
- **`uiVariants()` plugin** — `@databricks/appkit`. A dev-only recorder. Confirm
  POSTs `{ blockId, chosenIndex, label }` to `POST /api/ui-variants/confirm`; the
  plugin **upserts** the choice into a JSONL file keyed by `blockId`. **Register it
  conditionally** so it never mounts in production:
  `...(process.env.NODE_ENV === "development" ? [uiVariants()] : [])`.
- **Choices file** — `node_modules/.databricks/appkit/.appkit-ui-choices.jsonl`,
  gitignored. A **keyed store: one line per `<Variants>` blockId** (not an append
  log) — re-confirming a variant replaces that block's line, so the file always
  reflects the current choice:
  `{ "ts": "...", "blockId": "hero-cta", "chosenIndex": 1, "label": "Solid" }`.
  Its path is relative to the dev server's cwd, not the repo root, so
  **discover** it (step 4) rather than assuming a fixed location.

## The signal is turn-based

Do **not** start a background watcher. The confirm is recorded to the file; read
it on your next turn. The developer's "I've chosen" message is the signal to
finalize.

**How to prompt for that signal:**

- If your tool has an interactive question prompt **and** the developer is in an
  active session, you MAY ask via that prompt — options like **"I've picked —
  finalize" / "Still deciding" / "Cancel"** — to save them typing.
- Otherwise, ask in plain text and read the file on a later turn.

Two hard rules: the question **must** carry a "still deciding / later" option so
it never blocks the developer; and only ask when someone is there to answer —
if unsure, use plain text. If the developer says "done" but no line exists for
the block yet, they haven't clicked Confirm — ask them to, don't finalize
nothing.

## Authoring variants (agent rules)

- **Ask for _what_ and _where_; build for _how it looks_.** Before generating,
  ask at most one or two questions **only if the answer changes the build** —
  ambiguous target/surface, an unclear axis of variation, or real-vs-placeholder
  data on a data screen. Do **not** ask appearance/taste questions ("bold or
  minimal?", "which color?"); make one bold and one minimal instead. If the
  request is clear enough, skip questions. Never turn it into a checklist.
- **MUST** treat one `<Variants>` block as **one independent decision** and
  default to **one block per distinct section/region** the user names. A page
  with a hero and an about-us section is **two** blocks (`blockId="hero"`,
  `blockId="about"`), so the developer chooses each section independently. Use a
  single whole-page block **only** when the user asks for whole-page options or
  the sections must move together as one unit.
- **MUST** give every `<Variants>` block a **stable, unique `blockId`** within its
  file. Duplicate ids are ambiguous — refuse and disambiguate.
- **MUST** wrap each candidate in `<Variant label="…">` with a short, distinct
  label. The label is shown in the switcher and recorded on confirm.
- **SHOULD** default to **3 variants** unless the user asks for a specific
  count. Make them meaningfully different (layout / emphasis / density).
- Keep each variant self-contained: imports it needs should already be present
  so finalizing to any one of them leaves the file valid.
- **Layout:** `<Variants>` defaults to block layout (full-width, stacking) —
  correct for sections, heroes, and pages. Pass `layout="inline"` only when
  wrapping a small inline element such as a single button.
- Record the **file path + `blockId`** you used — you need both to finalize.

One block per section, each candidate a labelled `<Variant>`:

```tsx
import { Variants, Variant } from "@databricks/appkit-ui/react";

// "page with a hero and an about-us section" → one block per section
<Variants blockId="hero">
  <Variant label="Centered">…hero A…</Variant>
  <Variant label="Split with stats">…hero B…</Variant>
  <Variant label="Minimal">…hero C…</Variant>
</Variants>

<Variants blockId="about">
  <Variant label="Two column">…about A…</Variant>
  <Variant label="Timeline">…about B…</Variant>
  <Variant label="Team grid">…about C…</Variant>
</Variants>
```

## The confirm → finalize loop

1. Author the `<Variants>` block(s) in the target file.
2. Ensure `uiVariants()` is registered and the dev server is running.
3. Tell the developer to flip through variants in the browser, click **Confirm**
   on the one they want, and tell you when done. Do not start a watcher.
4. When the developer says they've chosen, **discover the choices file** (path
   is relative to the dev server's cwd):
   ```bash
   f=$(find . -path '*/node_modules/.databricks/appkit/.appkit-ui-choices.jsonl' 2>/dev/null | head -1)
   cat "$f"   # find the line for your block's blockId
   ```
5. For the line matching your block's `blockId`, **reconcile `chosenIndex` against
   `label`:** check the `<Variant>` at `chosenIndex` (zero-based) still has the
   recorded `label`. If they don't match, the file was edited after confirm —
   prefer the `<Variant>` whose `label` matches; if none matches, stop and ask
   the developer to re-confirm.
6. Find the `<Variants blockId="<that id>">` block and **replace the whole block with
   the chosen `<Variant>`'s inner JSX** — remove the `<Variants>`/`<Variant>`
   wrapper, drop the now-unused import if nothing else uses it, reconcile
   surrounding code, then format/lint the file
   (`pnpm check:fix`, or `pnpm biome check --write <file>`).
7. **Remove the consumed line** for that `blockId` from the choices file. Match the
   `blockId` structurally (not a loose substring) so a label containing the text
   can't delete the wrong line:
   `tmp=$(mktemp); jq -Rc 'fromjson? | select(.blockId != "<that id>")' "$f" > "$tmp" && mv "$tmp" "$f"`.
8. Confirm the finalized UI back to the developer.

## Edge cases

- **Developer confirms before the agent asks.** The choice waits in the file;
  read it whenever you next act.
- **Developer changed their mind.** The store is keyed by `blockId`, so re-confirming
  overwrites the previous line. Read whatever line is there now.
- **Endpoint absent (prod build / feature off).** The switcher still works as a
  viewer; Confirm shows "Recorder unavailable". Nothing is recorded — nothing to
  finalize.
- **Duplicate `blockId` in a file.** Ambiguous — refuse to finalize automatically;
  ask which block, or re-author with unique ids.

## Keeping it out of production

`<Variants>` is dev-time scaffolding. Always finalize (or remove) every block
before a production build — a leftover block ships the dev-only picker.

## Contract source

The choices-file path and record shape (`blockId`, `chosenIndex`, `label`) are owned
by the `uiVariants()` recorder in the installed `@databricks/appkit` package. If
finalization finds no file or a missing field, that package changed — reconcile
this skill against the version in use.
