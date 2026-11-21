// Outgoing HTTP to the media server. Plain node:http/https, so we can trust exactly one
// self-signed certificate by its SHA-256 fingerprint (a "pin") without turning certificate
// checks off for anything else. Nothing here logs a URL or a header.

import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export type HttpErrorKind = "network" | "timeout" | "cert-untrusted" | "pin-mismatch" | "too-large";

export class HttpError extends Error {
  constructor(
    readonly kind: HttpErrorKind,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface HttpRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Refuse bodies larger than this (default 32 MB). */
  maxBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

export type Http = (req: HttpRequest) => Promise<HttpResponse>;

/** Node's codes for a certificate the system doesn't trust (self-signed, unknown CA, expired, wrong name). */
const CERT_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "CERT_SIGNATURE_FAILURE",
  "HOSTNAME_MISMATCH",
]);

/** "AB:CD:…" or "abcd…" → "AB:CD:…" (64 hex digits), or "" when it isn't a SHA-256 fingerprint. */
export function normaliseFingerprint(fp: string | null | undefined): string {
  const hex = String(fp ?? "").replace(/^sha-?256[:= ]*/i, "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  return hex.length === 64 ? hex.match(/../g)!.join(":") : "";
}

/** Does the certificate's fingerprint match the pin? Constant format, case and separators ignored. */
export function pinMatches(pin: string | null | undefined, fingerprint: string | null | undefined): boolean {
  const a = normaliseFingerprint(pin);
  return !!a && a === normaliseFingerprint(fingerprint);
}

function friendlyNetError(err: NodeJS.ErrnoException): HttpError {
  const code = err.code ?? "";
  if (CERT_CODES.has(code)) return new HttpError("cert-untrusted", certWords(code), code);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new HttpError("network", "That server name doesn't exist (check the spelling).", code);
  if (code === "ECONNREFUSED") return new HttpError("network", "The server refused the connection: wrong port, or the server isn't running.", code);
  if (code === "ECONNRESET" || code === "EPIPE") return new HttpError("network", "The server closed the connection. If it's https, check you typed https (and the port is the https one).", code);
  if (code === "EPROTO" || /wrong version number|packet length too long/i.test(err.message)) return new HttpError("network", "That port doesn't speak https. Try http://, or the server's https port.", code);
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return new HttpError("network", "This box can't reach that server's network.", code);
  return new HttpError("network", `Couldn't connect (${code || err.message}).`, code);
}

export function certWords(code: string): string {
  switch (code) {
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return "The server's certificate is self-signed.";
    case "CERT_HAS_EXPIRED":
      return "The server's certificate has expired.";
    case "CERT_NOT_YET_VALID":
      return "The server's certificate isn't valid yet (check the server's clock).";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
    case "HOSTNAME_MISMATCH":
      return "The server's certificate is for a different name than the one typed.";
    default:
      return "The server's certificate isn't from an authority this box trusts.";
  }
}

const isIp = (h: string) => net.isIP(h.replace(/^\[|\]$/g, "")) !== 0;

/** Opens a TLS socket and keeps it only if the certificate is trusted or matches the pin. */
function pinnedSocket(u: URL, pin: string, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const sock = tls.connect({
      host,
      port: Number(u.port || 443),
      ...(isIp(host) ? {} : { servername: host }),
      // Checked by hand below: trusted by the system, or exactly the pinned certificate.
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });
    const timer = setTimeout(() => (sock.destroy(), reject(new HttpError("timeout", "The server didn't answer in time."))), timeoutMs);
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      const fp = sock.getPeerCertificate()?.fingerprint256;
      if (sock.authorized || pinMatches(pin, fp)) return resolve(sock);
      sock.destroy();
      reject(new HttpError("pin-mismatch", "The server's certificate changed: it isn't the one you trusted. If you replaced it, trust the new one in settings.", "PIN_MISMATCH"));
    });
    sock.once("error", (err) => (clearTimeout(timer), reject(friendlyNetError(err))));
  });
}

export function createHttp(opts: { pin?: () => string | null | undefined } = {}): Http {
  return async (r) => {
    const u = new URL(r.url);
    const timeoutMs = r.timeoutMs ?? 15_000;
    const maxBytes = r.maxBytes ?? 32 * 1024 * 1024;
    const pin = u.protocol === "https:" ? normaliseFingerprint(opts.pin?.()) : "";
    const sock = pin ? await pinnedSocket(u, pin, timeoutMs) : undefined;
    const headers: Record<string, string> = { "user-agent": "VenueboxMovies", accept: "application/json", ...r.headers };
    if (r.body !== undefined) headers["content-length"] = String(Buffer.byteLength(r.body));
    const mod = u.protocol === "https:" ? https : http;
    const options: http.RequestOptions = {
      method: r.method ?? "GET",
      host: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers,
      // No `agent` with createConnection: an agent (even agent: false) would open its own socket.
      ...(sock ? { createConnection: () => sock } : {}),
    };
    return new Promise<HttpResponse>((resolve, reject) => {
      // With a pinned socket the request rides it as plain HTTP (the TLS is already up).
      const req = (sock ? http : mod).request(options, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new HttpError("too-large", "The server's answer was too large."));
          } else chunks.push(c);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            text: () => body.toString("utf8"),
            json: <T>() => JSON.parse(body.toString("utf8")) as T,
          });
        });
        res.on("error", (err) => reject(friendlyNetError(err as NodeJS.ErrnoException)));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new HttpError("timeout", "The server didn't answer in time.")));
      req.on("error", (err) => reject(err instanceof HttpError ? err : friendlyNetError(err as NodeJS.ErrnoException)));
      if (r.body !== undefined) req.write(r.body);
      req.end();
    });
  };
}

export interface CertInfo {
  fingerprint: string;
  subject?: string;
  issuer?: string;
  validTo?: string;
  selfSigned: boolean;
  /** Trusted by the system as it is (then no pin is needed). */
  trusted: boolean;
  reason: string;
}

/** Reads the certificate an https server shows, without trusting it: for "trust this certificate?". */
export function probeCertificate(url: string, timeoutMs = 10_000): Promise<CertInfo> {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port: Number(u.port || 443), ...(isIp(host) ? {} : { servername: host }), rejectUnauthorized: false });
    const timer = setTimeout(() => (sock.destroy(), reject(new HttpError("timeout", "The server didn't answer in time."))), timeoutMs);
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      const c = sock.getPeerCertificate();
      const cn = (x?: Record<string, unknown>) => (x ? String(x.CN ?? x.O ?? "") : "");
      const err = sock.authorizationError ? String((sock.authorizationError as Error).message ?? sock.authorizationError) : "";
      const code = typeof sock.authorizationError === "string" ? sock.authorizationError : ((sock.authorizationError as NodeJS.ErrnoException | null)?.code ?? err);
      resolve({
        fingerprint: normaliseFingerprint(c.fingerprint256),
        subject: cn(c.subject as unknown as Record<string, unknown>) || undefined,
        issuer: cn(c.issuer as unknown as Record<string, unknown>) || undefined,
        validTo: c.valid_to,
        selfSigned: code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN" || (!!c.subject && JSON.stringify(c.subject) === JSON.stringify(c.issuer)),
        trusted: sock.authorized,
        reason: sock.authorized ? "trusted" : certWords(String(code)),
      });
      sock.destroy();
    });
    sock.once("error", (err) => (clearTimeout(timer), reject(friendlyNetError(err))));
  });
}
