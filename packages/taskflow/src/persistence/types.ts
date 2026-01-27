/**
 * Persistence layer types
 *
 * Types for event log and persistence configuration
 */

import type { EventLogEntry } from "@/domain";

/**
 * configuration for event log
 */
export interface EventLogConfig {
  /** path to the event log file */
  eventLogPath: string;
  /** maximum size of a string log file in bytes before rotation */
  maxSizeBytesPerFile: number;
  /** maximum age of a log file in milliseconds before rotation */
  maxAgePerFile: number;
  /** interval in milliseconds to check for rotation */
  rotationInterval: number;
  /** number of rotated files to retain */
  retentionCount: number;
}

/**
 * default event log configuration
 */
export const DEFAULT_EVENT_LOG_CONFIG: EventLogConfig = {
  eventLogPath: "./.taskflow/event.log",
  maxSizeBytesPerFile: 1024 * 1024 * 10, // 10MB
  maxAgePerFile: 1000 * 60 * 60, // 1 hour
  rotationInterval: 1000 * 60, // 1 minute
  retentionCount: 5,
};

/**
 * statistics about the event log
 */
export interface EventLogStats {
  /** status information */
  status: {
    /** whether the event log is initialized */
    initialized: boolean;
    /** Path to the event log file */
    path: string;
  };
  /** sequence tracking */
  sequence: {
    /** current sequence number */
    current: number;
  };
  /** Rotation information */
  rotation: {
    /** number of rotation performed */
    count: number;
    /** whether a rotation is currently in progress */
    isActive: boolean;
    /** timestamp of the last rotation */
    lastAt?: number;
  };

  /** volume tracking */
  volume: {
    /** total number of entries written */
    entriesWritten: number;
    /** count of malformed entries skipped during reads */
    malformedSkipped?: number;
  };
}

/**
 * Event log entry with sequence number and checksum
 * This is the format written to the WAL file
 */
export interface EventLogEvent extends EventLogEntry {
  /** monotonically increasing sequence number */
  seq: number;
  /** SHA-256 checksum of the canonicalized entry */
  checksum?: string;
}
