import type { WebSocket } from "ws";

export interface TunnelConnection {
  ws: WebSocket;
  owner: string;
  approvedViewers: Set<string>;
  pendingRequests: Set<string>;
  rejectedViewers: Set<string>;
  pendingFetches: Map<string, PendingFetch>;
  pendingFileReads: Map<string, PendingFileRead>; // For file read requests
  waitingForBinaryBody: string | null; // Track which path is waiting for binary data
}

export interface PendingFetch {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  metadata?: {
    status: number;
    headers: Record<string, any>;
  };
}

export interface PendingFileRead {
  resolve: (content: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}
