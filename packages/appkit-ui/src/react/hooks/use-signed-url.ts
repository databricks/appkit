import { useCallback, useRef, useState } from "react";

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
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

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
        const response = await fetch(
          apiUrl("download-url", { path: filePath }),
        );

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

    try {
      await navigator.clipboard.writeText(signedUrl.url);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = signedUrl.url;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
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
    generate,
    copyToClipboard,
    reset,
  };
}
