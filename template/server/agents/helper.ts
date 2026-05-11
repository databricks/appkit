{{if .plugins.agents -}}
import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';

/**
 * Code-defined agent: showcases the imperative `createAgent({...})` form
 * with inline `tool({...})` definitions.
 *
 * Tools here are intentionally dependency-free (no SQL warehouse, no
 * volumes, no external APIs) so this template demos the tool-calling
 * round-trip even when no other plugin is selected at scaffold time.
 *
 * The companion markdown agent at `config/agents/planner/agent.md`
 * shows the declarative form: pure-prose specialists whose entire
 * value is the system prompt — no tools, no compilation, one file
 * to edit. The agents plugin merges code-defined and markdown-defined
 * agents at boot, with code winning on key collision.
 */
export const helper = createAgent({
  name: 'helper',
  instructions: [
    'You are a tool-using helper agent.',
    'When the user asks about the time, call `current_time`.',
    'When the user asks to count words in a string, call `count_words`.',
    'For anything else, answer briefly in plain text.',
  ].join(' '),
  tools: {
    current_time: tool({
      description: 'Returns the current server time as an ISO 8601 timestamp.',
      schema: z.object({}),
      annotations: { effect: 'read' },
      execute: () => ({ now: new Date().toISOString() }),
    }),
    count_words: tool({
      description: 'Counts the words in a string. Words are runs of non-whitespace.',
      schema: z.object({
        text: z.string().describe('The text to count words in.'),
      }),
      annotations: { effect: 'read' },
      execute: ({ text }) => ({
        text,
        word_count: text.trim().split(/\s+/).filter(Boolean).length,
      }),
    }),
  },
});
{{- end}}
