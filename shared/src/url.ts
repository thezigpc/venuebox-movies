// The media server's address, as staff type it into settings. Anything goes: http or https,
// any host, any port, an optional base path (a reverse proxy's /jellyfin). Nothing in the app
// may depend on which: changing this one string must be all a move (a VPS tunnel) takes.

export type ServerUrlResult =
  | {
      ok: true;
      /** Normalised: scheme://host[:port][/base/path], no trailing slash, no query or hash. */
      url: string;
      /** http: the token in every stream link crosses the internet unencrypted. */
      insecure: boolean;
      /** What we changed, in words for the settings page ("No scheme typed: assuming http://"). */
      notes: string[];
    }
  | { ok: false; error: string };

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

export function normaliseServerUrl(input: string): ServerUrlResult {
  let raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "Type the server's address, e.g. https://media.example.org:8920." };
  if (/\s/.test(raw)) return { ok: false, error: "An address can't contain spaces." };
  const notes: string[] = [];
  const scheme = SCHEME.exec(raw)?.[1]?.toLowerCase();
  if (!scheme) {
    // "host:8096" would otherwise parse as scheme "host".
    raw = `http://${raw}`;
    notes.push("No http:// or https:// typed, so it assumes http://.");
  } else if (scheme !== "http" && scheme !== "https") {
    return { ok: false, error: `The address must start with http:// or https:// (not ${scheme}://).` };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "That isn't a web address. Example: https://media.example.org:8920/jellyfin" };
  }
  if (!u.hostname) return { ok: false, error: "The address has no server name." };
  if (u.username || u.password) return { ok: false, error: "Leave the user name and password out of the address: sign in below instead." };
  if (u.search || u.hash) notes.push("Dropped the part after ? or #.");
  let path = u.pathname.replace(/\/+$/, "");
  // Pasted from the browser while on Jellyfin's web app: the server is the part before /web.
  const web = /\/web(?:\/index\.html)?$/i.exec(path);
  if (web) {
    path = path.slice(0, web.index);
    notes.push("Dropped /web (that's Jellyfin's web app, not the server's address).");
  }
  // URL already lowercases the host and drops a default port (http :80, https :443).
  const url = `${u.protocol}//${u.host}${path}`;
  return { ok: true, url, insecure: u.protocol === "http:", notes };
}

/** The server address plus an API path, keeping any base path. */
export function serverPath(base: string, p: string): string {
  return `${base.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
}
