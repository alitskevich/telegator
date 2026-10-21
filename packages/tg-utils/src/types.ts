import type { LogFields } from "./logger";

/**
 * The pipeline's only source of wall-clock time. Injected rather than read from
 * `Date.now()`, so tests can prove that a replay leaves a message unchanged even
 * though every write stamps `ts: now()`.
 */
export interface Clock {
  /** Epoch milliseconds, the unit every stored timestamp uses. */
  now(): number;
}

/** Where a log line goes. Injected so tests can read what was written. */
export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}
