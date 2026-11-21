// Stream links, tokens and keys carry the venue's media-server credentials. Every log line
// goes through redact() first, so a stray URL or header can't leak them.

const R = "[redacted]";

const RULES: [RegExp, string][] = [
  // Query parameters: ?api_key=…, &ApiKey=…, &X-Plex-Token=…
  [/([?&;](?:api_?key|x-emby-token|x-mediabrowser-token|x-plex-token|access_?token|token)=)[^&\s"'#<>]*/gi, `$1${R}`],
  // JSON fields: "AccessToken":"…", "api_key": "…", "Pw":"…"
  [/("(?:access_?token|api_?key|token|x-emby-token|x-plex-token|x-mediabrowser-token|password|pw)"\s*:\s*")[^"]*/gi, `$1${R}`],
  // Token="…" inside a MediaBrowser / Emby Authorization header.
  [/(\btoken\s*=\s*\\?")[^"\\]*/gi, `$1${R}`],
  // Headers: "authorization: …", "X-Emby-Token: …" (also key=value and JSON-ish forms).
  [/(\b(?:authorization|x-emby-authorization|x-emby-token|x-mediabrowser-token|x-plex-token)\b["']?\s*[:=]\s*["']?)(?!\[redacted\])[^"'\n,}]*/gi, `$1${R}`],
  // Bearer tokens anywhere.
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${R}`],
];

export function redact(text: string): string {
  let s = String(text);
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s;
}
