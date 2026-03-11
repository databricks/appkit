import { useCallback, useEffect, useRef, useState } from "react";

// ============================================================================
// Types
// ============================================================================

export interface SignedUrl {
  url: string;
  expiresAt: string;
}

export interface UseSignedUrlResult {
  signedUrl: SignedUrl | null;
  loading: boolean;
  error: string | null;
  copied: boolean;
  /** Whether the signed URL has expired based on `expiresAt`. */
  expired: boolean;
  generate: (filePath: string) => Promise<void>;
  copyToClipboard: () => Promise<void>;
  reset: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useSignedUrl(
  apiUrl: (action: string, params?: Record<string, string>) => string,
): UseSignedUrlResult {
  const [signedUrl, setSignedUrl] = useState<SignedUrl | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expired, setExpired] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const expiryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(copiedTimer.current);
      clearTimeout(expiryTimer.current);
    };
  }, []);

  // Schedule expiry transition when a signed URL is set
  useEffect(() => {
    clearTimeout(expiryTimer.current);
    if (!signedUrl) {
      setExpired(false);
      return;
    }

    const msUntilExpiry = new Date(signedUrl.expiresAt).getTime() - Date.now();
    if (msUntilExpiry <= 0) {
      setExpired(true);
      return;
    }

    setExpired(false);
    expiryTimer.current = setTimeout(() => setExpired(true), msUntilExpiry);
  }, [signedUrl]);

  const reset = useCallback(() => {
    setSignedUrl(null);
    setError(null);
    setCopied(false);
  }, []);

  const generate = useCallback(
    async (filePath: string) => {
      setLoading(true);
      setError(null);
      setSignedUrl(null);

      try {
        const response = await fetch(apiUrl("download-url"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: filePath }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(
            data.error ?? `Failed to get signed URL (${response.status})`,
          );
        }

        const data = await response.json();
        setSignedUrl({ url: data.url, expiresAt: data.expiresAt });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [apiUrl],
  );

  const copyToClipboard = useCallback(async () => {
    if (!signedUrl) return;

    // navigator.clipboard requires a secure context (HTTPS).
    // Fall back to Selection API for http:// (e.g. local dev).
    if (navigator.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(signedUrl.url);
    } else {
      const range = document.createRange();
      const span = document.createElement("span");
      span.textContent = signedUrl.url;
      span.style.position = "fixed";
      span.style.opacity = "0";
      document.body.appendChild(span);
      range.selectNodeContents(span);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("copy");
      selection?.removeAllRanges();
      document.body.removeChild(span);
    }

    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  }, [signedUrl]);

  return {
    signedUrl,
    loading,
    error,
    copied,
    expired,
    generate,
    copyToClipboard,
    reset,
  };
}
