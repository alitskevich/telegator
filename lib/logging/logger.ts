export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

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

/**
 * The production sink. Lambda forwards stdout to CloudWatch Logs, and writing
 * the string directly guarantees one record per line — `console.log` is free to
 * add formatting, and a wrapped line is a record Logs Insights cannot parse.
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
    // that field rather than throw — this logger is called from `catch` blocks,
    // where throwing turns a handled failure into lost data (§1.3 L49).
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
 * A structured logger emitting one JSON object per line.
 *
 * The shape is load-bearing, not cosmetic: §7.7 L695 refuses a per-category
 * CloudWatch metric and sources the dashboard's category chart (§8.5 L771) from
 * a Logs Insights query over analyze's logs instead. Insights discovers fields
 * from the top level of each JSON line, so caller fields are lifted there.
 */
export function createLogger(sink: LogSink): Logger {
  const at =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      sink.write(encode(level, msg, fields));
    };

  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
