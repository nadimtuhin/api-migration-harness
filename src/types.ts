export type Envelope<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: T | null; error: string };

export type DiffKind =
  | "MISSING_KEY"
  | "UNEXPECTED_KEY"
  | "TYPE_MISMATCH"
  | "VALUE_MISMATCH"
  | "ARRAY_LENGTH";

export interface DiffItem {
  kind: DiffKind;
  path: string;
  legacyValue?: unknown;
  modernValue?: unknown;
  message: string;
}

export interface DiffSummary {
  total: number;
  missingKeys: number;
  unexpectedKeys: number;
  typeMismatches: number;
  valueMismatches: number;
  arrayLengthMismatches: number;
}

export interface DiffResult {
  identical: boolean;
  differences: DiffItem[];
  summary: DiffSummary;
}

export interface DiffOptions {
  ignorePaths?: string[];
  arrayOrderInsensitive?: boolean;
  numericTolerance?: number;
}

export interface DualRunConfig {
  legacyUrl: string;
  modernUrl: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  ignorePaths?: string[];
  timeoutMs?: number;
}

export interface EndpointResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  durationMs: number;
  body: unknown;
  rawText: string;
  isJson: boolean;
  error?: string;
}

export interface DualRunResult {
  parity: boolean;
  statusMatch: boolean;
  diff: DiffResult;
  legacy: EndpointResponse;
  modern: EndpointResponse;
  durationDeltaMs: number;
}

export interface IdempotencyConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  keyHeader?: string;
  key?: string;
  repeatCount?: number;
  probeUrl?: string;
  ignorePaths?: string[];
  timeoutMs?: number;
}

export interface IdempotencyRun {
  attempt: number;
  status: number;
  durationMs: number;
  headers: Record<string, string>;
  body: unknown;
  rawText: string;
  cacheHit?: boolean;
}

export interface IdempotencyResult {
  passed: boolean;
  idempotencyKey: string;
  statusConsistent: boolean;
  bodyConsistent: boolean;
  doubleWriteDetected: boolean;
  runs: IdempotencyRun[];
  differences: DiffItem[];
  probeResults?: {
    initialCount?: number;
    finalCount?: number;
    countDifference?: number;
  };
  details: string;
}
