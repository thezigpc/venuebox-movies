// The app's logger: the kit's one-line format, with every line passed through redact() so
// a stream URL, token or Authorization header never reaches the log (see shared/redact.ts).

import { createLogger, type Logger, type LogLevel } from "@bargames/gamekit/server";
import { redact } from "@movies/shared";

export function createSafeLogger(write?: (line: string, level: LogLevel) => void): Logger {
  const out = write ?? ((line: string, level: LogLevel) => (level === "error" || level === "warn" ? console.error(line) : console.log(line)));
  return createLogger({ write: (line, level) => out(redact(line), level) });
}

export const log = createSafeLogger();
