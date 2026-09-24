/**
 * Structured JSON logging. One line per event, always carrying `orderId`
 * when one is known, so a support question is answered by grepping one ID.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface LogLine extends LogFields {
  ts: string;
  level: LogLevel;
  event: string;
}

type Sink = (line: LogLine) => void;

/**
 * `undefined` is dropped by JSON.stringify, which silently removes a field
 * from a log line. A diagnostic that disappears exactly when the value is
 * missing is worse than useless, so undefined is serialised as null.
 */
function stringifyLine(line: LogLine): string {
  return JSON.stringify(line, (_key, value) => (value === undefined ? null : value));
}

let sink: Sink = (line) => {
  const text = stringifyLine(line);
  if (line.level === "error" || line.level === "warn") process.stderr.write(text + "\n");
  else process.stdout.write(text + "\n");
};

/** Test hook: capture log lines instead of printing them. */
export function setLogSink(next: Sink | null): void {
  sink = next ?? ((line) => process.stdout.write(stringifyLine(line) + "\n"));
}

export function serializeError(err: unknown): LogFields {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...("cause" in err && err.cause ? { cause: serializeError(err.cause) } : {}),
      ...(typeof (err as { details?: unknown }).details !== "undefined"
        ? { details: (err as { details?: unknown }).details }
        : {}),
    };
  }
  return { message: String(err) };
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  const { error, ...rest } = fields;
  sink({
    ts: new Date().toISOString(),
    level,
    event,
    ...rest,
    ...(error !== undefined ? { error: serializeError(error) } : {}),
  });
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Returns a logger that merges `fields` (typically `{ orderId }`) into every line. */
  child(fields: LogFields): Logger;
}

function makeLogger(base: LogFields): Logger {
  return {
    debug: (event, fields = {}) => emit("debug", event, { ...base, ...fields }),
    info: (event, fields = {}) => emit("info", event, { ...base, ...fields }),
    warn: (event, fields = {}) => emit("warn", event, { ...base, ...fields }),
    error: (event, fields = {}) => emit("error", event, { ...base, ...fields }),
    child: (fields) => makeLogger({ ...base, ...fields }),
  };
}

export const log: Logger = makeLogger({});
