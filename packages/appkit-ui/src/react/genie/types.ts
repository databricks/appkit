import type { GenieAttachmentResponse } from "shared";

export type {
  GenieAttachmentResponse,
  GenieMessageResponse,
  GenieStreamEvent,
} from "shared";

export type GenieChatStatus =
  | "idle"
  | "loading-history"
  | "loading-older"
  | "streaming"
  | "error";

export interface GenieMessageItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  attachments: GenieAttachmentResponse[];
  queryResults: Map<string, unknown>;
  error?: string;
}

export interface UseGenieChatOptions {
  /** Genie space alias (maps to backend route param) */
  alias: string;
  /** Base API path. Default: "/api/genie" */
  basePath?: string;
  /** Read/write conversationId from URL search params. Default: true */
  persistInUrl?: boolean;
  /** URL search param name. Default: "conversationId" */
  urlParamName?: string;
}

export interface UseGenieChatReturn {
  messages: GenieMessageItem[];
  status: GenieChatStatus;
  conversationId: string | null;
  error: string | null;
  sendMessage: (content: string) => void;
  reset: () => void;
  /** Whether a previous page of older messages exists */
  hasPreviousPage: boolean;
  /** Whether a previous page is currently being fetched */
  isFetchingPreviousPage: boolean;
  /** Fetch the previous page of older messages */
  fetchPreviousPage: () => void;
}

export interface GenieChatProps {
  /** Genie space alias (must match a key registered with the genie plugin on the server) */
  alias: string;
  /** Base API path */
  basePath?: string;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Additional CSS class for the root container */
  className?: string;
}
