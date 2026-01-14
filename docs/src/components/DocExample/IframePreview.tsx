import type React from "react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import useBaseUrl from "@docusaurus/useBaseUrl";
import { Toaster } from "sonner";
import { PortalContainerProvider } from "../../../../packages/appkit-ui/src/react/portal-container-context";
import styleVersion from "../../../static/appkit-ui/styles.version.json";

// Timing constants for delays and retries
const TIMING = {
  INITIAL_HEIGHT_DELAY: 100,
  SONNER_STYLE_RETRY: 100,
  SONNER_INITIAL_DELAY: 100,
} as const;

// Dimension constants for iframe sizing
const DIMENSIONS = {
  MIN_HEIGHT: 200,
  MAX_HEIGHT: 800,
  DEFAULT_HEIGHT: 400,
  CONTENT_PADDING: 16,
  HEIGHT_BUFFER: 20,
} as const;

// Maximum retry attempts for style synchronization
const MAX_STYLE_SYNC_RETRIES = 10;

interface IframePreviewProps {
  children: React.ReactNode;
  customHeight?: number;
  componentName?: string;
}

/**
 * Generates the HTML template for the iframe document
 */
function getIframeHTML(stylesHref: string): string {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link rel="stylesheet" href="${stylesHref}">
        <style>
          html, body {
            margin: 0;
            padding: 0;
            height: auto;
            overflow: visible;
          }
          body {
            padding: ${DIMENSIONS.CONTENT_PADDING}px;
          }
          #preview-root {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: ${DIMENSIONS.MIN_HEIGHT}px;
          }
        </style>
      </head>
      <body>
        <div id="preview-root"></div>
      </body>
    </html>
  `;
}

/**
 * Sync dark mode between parent document and iframe
 */
function useDarkModeSync(iframeRef: RefObject<HTMLIFrameElement>) {
  useEffect(() => {
    if (!iframeRef.current?.contentDocument) return;

    const iframeDoc = iframeRef.current.contentDocument;
    const parentHtml = document.documentElement;

    const syncTheme = () => {
      const isDark = parentHtml.getAttribute("data-theme") === "dark";
      iframeDoc.documentElement.classList.toggle("dark", isDark);
    };

    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(parentHtml, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });

    return () => observer.disconnect();
  }, [iframeRef]);
}

/**
 * Automatically adjust iframe height based on content
 */
function useIframeAutoHeight(
  iframeRef: RefObject<HTMLIFrameElement>,
  customHeight?: number,
) {
  const [iframeHeight, setIframeHeight] = useState<number>(
    customHeight || DIMENSIONS.DEFAULT_HEIGHT,
  );

  useEffect(() => {
    if (!iframeRef.current?.contentDocument?.body) return;

    // If custom height is provided, use it and skip auto-sizing
    if (customHeight) {
      setIframeHeight(customHeight);
      return;
    }

    const iframeDoc = iframeRef.current.contentDocument;

    const updateHeight = () => {
      const contentHeight = iframeDoc.body.scrollHeight;
      const newHeight = Math.min(
        Math.max(
          contentHeight + DIMENSIONS.HEIGHT_BUFFER,
          DIMENSIONS.MIN_HEIGHT,
        ),
        DIMENSIONS.MAX_HEIGHT,
      );
      setIframeHeight(newHeight);
    };

    const initialTimeout = setTimeout(
      updateHeight,
      TIMING.INITIAL_HEIGHT_DELAY,
    );

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(iframeDoc.body);

    return () => {
      clearTimeout(initialTimeout);
      resizeObserver.disconnect();
    };
  }, [customHeight, iframeRef]);

  return iframeHeight;
}

/**
 * Sync Sonner toast styles from parent to iframe.
 * Only active when componentName is "sonner".
 * This is necessary because Sonner styles are injected into the parent document,
 * so we need to sync them to the iframe.
 */
function useSonnerStyleSync(
  iframeRef: RefObject<HTMLIFrameElement>,
  componentName?: string,
) {
  useEffect(() => {
    if (componentName !== "sonner" || !iframeRef.current?.contentDocument) {
      return;
    }

    const iframeDoc = iframeRef.current.contentDocument;
    let retryCount = 0;

    const syncSonnerStyles = () => {
      const sonnerStyles = Array.from(
        document.querySelectorAll("style"),
      ).filter(
        (style) =>
          style.textContent?.includes("[data-sonner-toaster]") ||
          style.textContent?.includes("[data-sonner-toast]"),
      );

      if (sonnerStyles.length > 0) {
        sonnerStyles.forEach((style) => {
          const cloned = style.cloneNode(true) as HTMLStyleElement;
          iframeDoc.head.appendChild(cloned);
        });
      } else if (retryCount < MAX_STYLE_SYNC_RETRIES) {
        // Retry if Sonner hasn't injected styles yet
        retryCount++;
        setTimeout(syncSonnerStyles, TIMING.SONNER_STYLE_RETRY);
      }
    };

    // Wait for Sonner to inject its styles
    setTimeout(syncSonnerStyles, TIMING.SONNER_INITIAL_DELAY);
  }, [componentName, iframeRef]);
}

export function IframePreview({
  children,
  customHeight,
  componentName,
}: IframePreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeBody, setIframeBody] = useState<HTMLElement | null>(null);
  const stylesHref = useBaseUrl(
    `/appkit-ui/styles.gen.css?v=${styleVersion.version}`,
  );

  const iframeHeight = useIframeAutoHeight(iframeRef, customHeight);
  useDarkModeSync(iframeRef);
  useSonnerStyleSync(iframeRef, componentName);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const iframeDoc = iframe.contentDocument;
    if (!iframeDoc) return;

    iframeDoc.open();
    iframeDoc.write(getIframeHTML(stylesHref));
    iframeDoc.close();

    const link = iframeDoc.querySelector('link[rel="stylesheet"]');
    if (link) {
      link.addEventListener("load", () => {
        const root = iframeDoc.getElementById("preview-root");
        setIframeBody(root);
      });

      link.addEventListener("error", () => {
        // Still try to show content even if styles fail
        const root = iframeDoc.getElementById("preview-root");
        setIframeBody(root);
      });
    } else {
      // Fallback if link not found
      const root = iframeDoc.getElementById("preview-root");
      setIframeBody(root);
    }
  }, [stylesHref]);

  return (
    <iframe
      ref={iframeRef}
      style={{
        width: "100%",
        height: `${iframeHeight}px`,
        minHeight: `${DIMENSIONS.MIN_HEIGHT}px`,
        maxHeight: `${DIMENSIONS.MAX_HEIGHT}px`,
        border: "none",
        display: "block",
        backgroundColor: "transparent",
        borderRadius: "8px",
        transition: "height 0.2s ease",
      }}
      title="Component Preview"
    >
      {iframeBody &&
        createPortal(
          <PortalContainerProvider
            container={iframeRef.current?.contentDocument?.body ?? null}
          >
            <Toaster />
            {children}
          </PortalContainerProvider>,
          iframeBody,
        )}
    </iframe>
  );
}
