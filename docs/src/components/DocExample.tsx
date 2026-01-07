import React, { useLayoutEffect, useRef, useState } from "react";
import CodeBlock from "@theme/CodeBlock";
import {
  examples,
  type AppKitExampleKey,
} from "../../../packages/appkit-ui/src/react/ui/examples";

import { createPortal } from "react-dom";
import useBaseUrl from "@docusaurus/useBaseUrl";


interface DocExampleProps {
  name: AppKitExampleKey;
}

export function DocExample({ name }: DocExampleProps) {
  const example = examples[name];
  if (!example) {
    return null;
  }

  const ExampleComponent = example.Component;
  const previewHostRef = useRef<HTMLDivElement>(null);
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);
  const baseStylesHref = useBaseUrl("/appkit-ui/styles.css");
  const [stylesHref, setStylesHref] = useState(baseStylesHref);

  useLayoutEffect(() => {
    const host = previewHostRef.current;
    if (!host || typeof document === "undefined") {
      return;
    }

    let root = host.shadowRoot;
    if (!root) {
      root = host.attachShadow({ mode: "open" });
    }

    let link = root.querySelector("link[data-appkit-preview]") as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "stylesheet";
      link.setAttribute("data-appkit-preview", "");
      root.appendChild(link);
    }

    link.href = stylesHref;

    setShadowRoot(root);

    return () => {
      if (host.shadowRoot === root) {
        host.innerHTML = "";
      }
    };
  }, [stylesHref]);

  useLayoutEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const baseElement = document.querySelector("base");
    const baseHref = baseElement?.getAttribute("href");
    if (!baseHref) {
      return;
    }

    const origin = window.location.origin;
    const prefix = baseHref.startsWith("http") ? baseHref : `${origin}${baseHref}`;
    try {
      const resolved = new URL("appkit-ui/styles.css", prefix);
      setStylesHref((current) =>
        current === resolved.pathname ? current : resolved.pathname,
      );
    } catch {
      // fall back to the baseStylesHref already set
    }
  }, [baseStylesHref]);

  return (
    <section className="doc-example">
      <div className="doc-example-preview" ref={previewHostRef}>
        {shadowRoot &&
          createPortal(
            <div className="doc-example-preview-contents">
              <ExampleComponent />
            </div>,
            shadowRoot
          )}
      </div>
      <div className="doc-example-source">
        <CodeBlock language="tsx">{example.source}</CodeBlock>
      </div>
    </section>
  );
}

