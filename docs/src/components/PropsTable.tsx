import React from "react";

interface PropInfo {
  name: string;
  type: { name: string };
  required: boolean;
  description: string;
  defaultValue?: { value: string } | null;
}

interface PropsTableProps {
  props: Record<string, PropInfo>;
}

export function PropsTable({ props }: PropsTableProps) {
  const propEntries = Object.entries(props);

  if (propEntries.length === 0) {
    return <p>This component extends standard HTML element attributes.</p>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Prop</th>
          <th>Type</th>
          <th>Required</th>
          <th>Default</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {propEntries.map(([name, prop]) => (
          <tr key={name}>
            <td>
              <code>{name}</code>
            </td>
            <td>
              <code>{prop.type.name}</code>
            </td>
            <td>{prop.required ? "✓" : ""}</td>
            <td>
              {prop.defaultValue?.value ? (
                <code>{prop.defaultValue.value}</code>
              ) : (
                "-"
              )}
            </td>
            <td>{prop.description || "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
