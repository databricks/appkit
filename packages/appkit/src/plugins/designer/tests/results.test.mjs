import assert from "node:assert/strict";

import { test } from "vitest";

import { exportedModelToRunPayload } from "../server/exportedRunOutput";
import { matchRunOutputs } from "../server/runOutputs";
const ROW_COUNTS_MIME_TYPE =
  "application/vnd.databricks.lakeflow-designer.row-counts+json";
const FILES_MIME_TYPE =
  "application/vnd.databricks.lakeflow-designer.files+json";
const NODE_STATE_MIME_TYPE =
  "application/vnd.databricks.lakebuilder.runtime-node-state+json";
function displayTable(rowCount, overflow) {
  return {
    type: "table",
    schema: [{ name: "value", type: '"long"', nullable: true }],
    data: Array.from({ length: rowCount }, (_, i) => [i]),
    ...(overflow === undefined ? {} : { overflow }),
  };
}

function rowCounts(node, counts) {
  return {
    type: "mimeBundle",
    data: { [ROW_COUNTS_MIME_TYPE]: { node, counts } },
  };
}

function notebookHtml(commands) {
  const model = Buffer.from(
    encodeURIComponent(JSON.stringify({ commands })),
  ).toString("base64");
  return `<script>__DATABRICKS_NOTEBOOK_MODEL = '${model}'</script>`;
}

function nodeState(nodeId, disabled) {
  return {
    type: "mimeBundle",
    data: { [NODE_STATE_MIME_TYPE]: { nodeId, disabled } },
  };
}

function guardrailCommand(nodeId, name, text, extra = {}) {
  return {
    command: `"""\nid: ${nodeId}\ntemplate: guardrails\ntemplateVersion: 2.0.0\nname: ${name}\n"""\nrun(config, inputs, spark)`,
    results: { type: "ansi", data: text },
    ...extra,
  };
}

const warningText =
  '[guardrails] WARNING: checks[0] (not_null): column "id" has 3 null values';

test("runtime states do not shift table ports, row counts, or file receipts", () => {
  const files = {
    node: "writer",
    files: [{ path: "/Volumes/main/apps/files/report.csv" }],
  };
  const html = notebookHtml([
    {
      command: 'display(ctx["source.data"])\ndisplay(ctx["source.summary"])',
      results: {
        data: [
          nodeState("source", false),
          displayTable(2, true),
          {
            type: "mimeBundle",
            data: {
              [NODE_STATE_MIME_TYPE]: JSON.stringify({
                nodeId: "writer",
                disabled: true,
              }),
            },
          },
          { type: "mimeBundle", data: { [FILES_MIME_TYPE]: files } },
          displayTable(1, false),
          rowCounts("source", { data: 4000, summary: 1 }),
        ],
      },
    },
  ]);
  const parsed = JSON.parse(exportedModelToRunPayload(html));
  assert.deepEqual(parsed.runtimeNodeStates, {
    source: { disabled: false },
    writer: { disabled: true },
  });
  assert.deepEqual(
    parsed.outputs.map(({ target_node, target_port, total_row_count }) => ({
      target_node,
      target_port,
      total_row_count,
    })),
    [
      { target_node: "source", target_port: "data", total_row_count: 4000 },
      { target_node: "source", target_port: "summary", total_row_count: 1 },
    ],
  );
  assert.deepEqual(parsed.files, [files]);
});

test("singleton runtime states survive missing tables and later states replace earlier ones", () => {
  const parsed = JSON.parse(
    exportedModelToRunPayload(
      notebookHtml([
        { command: "run()", results: nodeState("writer", true) },
        { command: "run()", results: nodeState("writer", false) },
        { command: "group_gate()", results: nodeState("group", true) },
      ]),
    ),
  );
  assert.deepEqual(parsed.runtimeNodeStates, {
    writer: { disabled: false },
    group: { disabled: true },
  });
  assert.deepEqual(parsed.outputs, []);
});

test("malformed runtime metadata preserves valid sibling state and results", () => {
  const invalid = [
    null,
    "not JSON",
    [],
    {},
    { nodeId: "", disabled: true },
    { nodeId: "source", disabled: "true" },
    { nodeId: "source", disabled: 1 },
  ];
  const parsed = JSON.parse(
    exportedModelToRunPayload(
      notebookHtml([
        {
          command: 'display(ctx["source.data"])',
          results: {
            data: [
              nodeState("source", false),
              ...invalid.map((payload) => ({
                type: "mimeBundle",
                data: { [NODE_STATE_MIME_TYPE]: payload },
              })),
              displayTable(1, false),
            ],
          },
        },
      ]),
    ),
  );
  assert.deepEqual(parsed.runtimeNodeStates, { source: { disabled: false } });
  assert.equal(parsed.outputs[0].target_port, "data");
});

test("file receipts are decoded independently of tables and full counts without shifting display ports", () => {
  const receipt = {
    node: "output_0",
    files: [{ path: "/Volumes/main/apps/files/sheet.xlsx" }],
  };
  const html = notebookHtml([
    {
      command: "write_output()",
      results: {
        type: "listResults",
        data: [
          {
            type: "mimeBundle",
            data: { [FILES_MIME_TYPE]: JSON.stringify(receipt) },
          },
        ],
      },
    },
    {
      command: 'display(ctx["source_0.data"])',
      results: {
        type: "listResults",
        data: [
          {
            type: "mimeBundle",
            data: { [FILES_MIME_TYPE]: { node: "output_1", files: [] } },
          },
          displayTable(2, true),
          rowCounts("source_0", { data: 12345 }),
        ],
      },
    },
  ]);
  const parsed = JSON.parse(exportedModelToRunPayload(html));
  assert.deepEqual(parsed.files, [receipt, { node: "output_1", files: [] }]);
  assert.equal(parsed.outputs.length, 1);
  assert.equal(parsed.outputs[0].target_node, "source_0");
  assert.equal(parsed.outputs[0].total_row_count, 12345);
});

test("a singleton file MIME receipt remains available when no preview was produced", () => {
  const receipt = {
    node: "output_0",
    files: [{ path: "/Volumes/main/apps/files/report.csv" }],
  };
  const parsed = JSON.parse(
    exportedModelToRunPayload(
      notebookHtml([
        {
          command: "write_file()",
          results: { type: "mimeBundle", data: { [FILES_MIME_TYPE]: receipt } },
        },
      ]),
    ),
  );
  assert.deepEqual(parsed.files, [receipt]);
  assert.deepEqual(parsed.outputs, []);
});

test("file MIME receipts retain their effective behavior and ignore unrecognized metadata", () => {
  for (const behavior of [
    "run_artifact",
    "shared_append",
    "shared_workbook_update",
    undefined,
    "overwrite",
    null,
    {},
  ]) {
    const receipt = {
      node: "output_0",
      files: [{ path: "/Volumes/main/apps/files/report.csv" }],
      behavior,
    };
    const parsed = JSON.parse(
      exportedModelToRunPayload(
        notebookHtml([
          {
            command: "write_file()",
            results: {
              type: "mimeBundle",
              data: { [FILES_MIME_TYPE]: receipt },
            },
          },
        ]),
      ),
    );
    assert.deepEqual(parsed.files, [
      {
        node: receipt.node,
        files: receipt.files,
        ...([
          "run_artifact",
          "shared_append",
          "shared_workbook_update",
        ].includes(behavior)
          ? { behavior }
          : {}),
      },
    ]);
  }
});

test("malformed file receipts do not discard valid sibling receipts or table counts", () => {
  const invalid = [
    "not JSON",
    {},
    { node: "output", files: [{}] },
    {
      node: "output",
      files: Array.from({ length: 51 }, () => ({
        path: "/Volumes/a/b/c/data.csv",
      })),
    },
  ];
  const html = notebookHtml([
    {
      command: 'display(ctx["source_0.data"])',
      results: {
        data: [
          ...invalid.map((receipt) => ({
            type: "mimeBundle",
            data: { [FILES_MIME_TYPE]: receipt },
          })),
          displayTable(1, false),
          rowCounts("source_0", { data: 1 }),
        ],
      },
    },
  ]);
  const parsed = JSON.parse(exportedModelToRunPayload(html));
  assert.deepEqual(parsed.files, []);
  assert.equal(parsed.outputs[0].total_row_count, 1);
});

test("keeps overflow and counts isolated per displayed port, including encoded exports", () => {
  const html = notebookHtml([
    {
      command:
        'display(ctx["filter.filtered_data"])\ndisplay(ctx["filter.excluded_data"])',
      results: { data: [displayTable(990, false), displayTable(1000, true)] },
    },
    {
      command: 'display(ctx["viz.data"])',
      results: { data: [displayTable(12, false)] },
    },
  ]);
  const plain = exportedModelToRunPayload(html);
  assert.equal(
    exportedModelToRunPayload(Buffer.from(html).toString("base64")),
    plain,
  );
  assert.deepEqual(
    JSON.parse(plain).outputs.map(
      ({ target_node, target_port, rows, truncated, total_row_count }) => ({
        target_node,
        target_port,
        rows: rows.length,
        truncated,
        total_row_count,
      }),
    ),
    [
      {
        target_node: "filter",
        target_port: "filtered_data",
        rows: 990,
        truncated: false,
        total_row_count: 990,
      },
      {
        target_node: "filter",
        target_port: "excluded_data",
        rows: 1000,
        truncated: true,
        total_row_count: undefined,
      },
      {
        target_node: "viz",
        target_port: "data",
        rows: 12,
        truncated: false,
        total_row_count: 12,
      },
    ],
  );
});

test("invalid notebook exports remain unreadable instead of fabricating an empty complete result", () => {
  for (const html of [
    undefined,
    null,
    "",
    "<html>not a notebook</html>",
    "__DATABRICKS_NOTEBOOK_MODEL = 'invalid'",
  ]) {
    assert.equal(exportedModelToRunPayload(html), undefined);
  }
});

test("ignores malformed count metadata and preserves the preview completeness signal", () => {
  for (const marker of [
    rowCounts("", { data: 50 }),
    rowCounts("source_0", {}),
    rowCounts("source_0", { data: -1 }),
    rowCounts("source_0", { data: 1.5 }),
    rowCounts("source_0", { data: "50" }),
  ]) {
    const html = notebookHtml([
      {
        command: 'display(ctx["source_0.data"])',
        results: { data: [displayTable(10, true), marker] },
      },
    ]);
    const output = JSON.parse(exportedModelToRunPayload(html)).outputs[0];
    assert.equal(output.total_row_count, undefined);
    assert.equal(output.truncated, true);
  }
});

const HTML_BLOCK = {
  type: "output",
  id: "page",
  nodeId: "html_1",
  kind: "html",
  label: "Report",
};

const htmlCommand = (html, extra = {}) => ({
  command: '# designer-app-html-output: "html_1"',
  results: {
    type: "listResults",
    data: [{ type: "mimeBundle", data: { "text/html": html } }],
  },
  ...extra,
});

const branches = ["prod", "dev"].map((nodeId) => ({
  type: "output",
  id: nodeId,
  nodeId,
  port: "data",
  parentGroupId: `group_${nodeId}`,
}));
for (const environment of ["prod", "dev"]) {
  test(`group state disables only the inactive ${environment} branch`, () => {
    const commands = ["prod", "dev"].flatMap((nodeId) => [
      {
        command: "group_gate()",
        results: nodeState(`group_${nodeId}`, nodeId !== environment),
      },
      {
        command: `display(ctx["${nodeId}.data"])`,
        results: displayTable(nodeId === environment ? 1 : 0, false),
      },
    ]);
    const result = matchRunOutputs(
      branches,
      exportedModelToRunPayload(notebookHtml(commands)),
    );
    assert.deepEqual(
      result.outputs.map(({ id, disabled }) => ({ id, disabled })),
      [
        { id: "prod", disabled: environment !== "prod" },
        { id: "dev", disabled: environment !== "dev" },
      ],
    );
  });
}
for (const own of [true, false])
  for (const group of [true, false]) {
    test(`combines node ${own} and group ${group} disablement`, () => {
      const result = matchRunOutputs(
        [branches[0]],
        exportedModelToRunPayload(
          notebookHtml([
            {
              command: "group_gate()",
              results: nodeState("group_prod", group),
            },
            {
              command: 'display(ctx["prod.data"])',
              results: {
                data: [nodeState("prod", own), displayTable(0, false)],
              },
            },
          ]),
        ),
      );
      assert.equal(result.outputs[0].disabled, own || group);
    });
  }

test("disabled file outputs remain hidden without a preview or file receipt", () => {
  const result = matchRunOutputs(
    branches.map((block) => ({
      ...block,
      fileOutput: { volumes: ["main.apps.files"] },
    })),
    exportedModelToRunPayload(
      notebookHtml([
        { command: "group_gate()", results: nodeState("group_prod", true) },
        { command: "group_gate()", results: nodeState("group_dev", false) },
      ]),
    ),
  );
  assert.deepEqual(
    result.outputs.map(({ disabled, files }) => ({ disabled, files })),
    [
      { disabled: true, files: [] },
      { disabled: false, files: [] },
    ],
  );
});

test("preserves HTML content and selects only the published HTML node", () => {
  const result = matchRunOutputs(
    [HTML_BLOCK],
    exportedModelToRunPayload(notebookHtml([htmlCommand("<h1>Report</h1>")])),
  );
  assert.deepEqual(result.outputs[0].outcome, {
    outcome: "html",
    html: "<h1>Report</h1>",
  });
});

test("returns upstream guardrail diagnostics alongside selected outputs", () => {
  const result = matchRunOutputs(
    [branches[0]],
    exportedModelToRunPayload(
      notebookHtml([
        guardrailCommand("checks", "Quality", warningText),
        {
          command: 'display(ctx["prod.data"])',
          results: displayTable(1, false),
        },
      ]),
    ),
  );
  assert.equal(result.outcome, "outputs");
  assert.equal(result.diagnostics[0].message, 'column "id" has 3 null values');
});
