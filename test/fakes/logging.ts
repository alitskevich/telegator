import type { LogSink } from "../../lib/logging/logger";

export interface RecordingSink extends LogSink {
  readonly lines: string[];
}

/** Captures log lines so a test can assert on the record, not on a spy. */
export function recordingSink(): RecordingSink {
  const lines: string[] = [];
  return {
    lines,
    write: (line) => {
      lines.push(line);
    },
  };
}
