import React from "react";
import { PropsTable } from "./PropsTable";

interface ComponentDocProps {
  component: {
    displayName: string;
    description: string;
    filePath: string;
    props: Record<string, any>;
  };
}

export function ComponentDoc({ component }: ComponentDocProps) {
  const { displayName, description, filePath, props } = component;

  // Extract relative path
  const relativePath = filePath.split("/appkit/")[1] || filePath;

  return (
    <div>
      <h1>{displayName}</h1>

      {description && <p>{description}</p>}

      <p>
        <strong>Source:</strong>{" "}
        <a
          href={`https://github.com/databricks/appkit/blob/main/${relativePath}`}
        >
          {relativePath}
        </a>
      </p>

      <h2>Props</h2>
      <PropsTable props={props} />

      <h2>Usage</h2>
      <pre>
        <code className="language-tsx">
          {`import { ${displayName} } from '@databricks/appkit-ui';

<${displayName} />`}
        </code>
      </pre>
    </div>
  );
}
