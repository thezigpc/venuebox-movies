// Posters for the staff page come through this app, never straight from the media server:
// the page is https on the box (an http server's images would be blocked as mixed content),
// the server may use a pinned certificate the iPad doesn't trust, and the iPad never needs
// the server's address. Poster links are signed, so <img> tags work without a sign-in
// header and nobody can use this as an open proxy into the library.

import { createHmac, timingSafeEqual } from "node:crypto";

export const POSTER_WIDTHS = [200, 300, 480] as const;

export function posterSig(key: string, id: string, w: number): string {
  return createHmac("sha256", key).update(`${id}|${w}`).digest("hex").slice(0, 24);
}

export function posterPath(key: string, id: string, w = 300): string {
  return `/api/poster/${encodeURIComponent(id)}?w=${w}&s=${posterSig(key, id, w)}`;
}

export function checkPosterSig(key: string, id: string, w: number, sig: string): boolean {
  const want = Buffer.from(posterSig(key, id, w));
  const got = Buffer.from(String(sig));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** A small in-memory cache: posters repeat as staff scroll back and forth. */
export class PosterCache {
  private map = new Map<string, { contentType: string; body: Buffer }>();
  private bytes = 0;
  constructor(private readonly maxBytes = 24 * 1024 * 1024) {}

  get(k: string) {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }

  set(k: string, v: { contentType: string; body: Buffer }) {
    if (v.body.length > this.maxBytes / 4) return;
    const old = this.map.get(k);
    if (old) (this.bytes -= old.body.length), this.map.delete(k);
    this.map.set(k, v);
    this.bytes += v.body.length;
    for (const [key, val] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(key);
      this.bytes -= val.body.length;
    }
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}
