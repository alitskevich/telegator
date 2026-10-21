import type { Logger, LogSink } from "./types";
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

/**
 * The production sink. Writing the string directly guarantees one record per
 * line; `console.log` may add formatting that breaks structured parsing.
 */
export const stdoutSink: LogSink = {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
};

function encode(level: LogLevel, msg: string, fields: LogFields | undefined): string {
  // Caller fields are spread first so `level` and `msg` always win: a log line
  // that can misreport its own severity is worse than a dropped field.
  try {
    return JSON.stringify({ ...fields, level, msg });
  } catch {
    // Something in `fields` is circular or otherwise unserialisable. Degrade
    // that field rather than throw: this logger is called from `catch` blocks,
    // where throwing turns a handled failure into lost data.
    const safe: LogFields = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
      try {
        JSON.stringify(value);
        safe[key] = value;
      } catch {
        safe[key] = "[unserializable]";
      }
    }
    return JSON.stringify({ ...safe, level, msg });
  }
}

/**
 * A structured logger emitting one JSON object per line, with caller fields at
 * the top level so Cloud Logging indexes them.
 */
export function createLogger(sink: LogSink): Logger {
  const at =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      sink.write(encode(level, msg, fields));
    };

  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/** The process logger: one JSON object per line, which Cloud Logging reads as structured. */
export const log = createLogger(stdoutSink);
