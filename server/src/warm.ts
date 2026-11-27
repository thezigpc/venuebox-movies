// Before a TV is handed the server's HLS, we fetch the part it will ask for first. That starts
// the server's conversion (so the TV isn't left waiting on a slow start), shows a failure to
// staff as words instead of an error on the TV, and times the conversion: a server that can't
// keep up with a 4K picture is asked for 1080p instead. The link is never logged.

import { HttpError, type Http } from "./http.js";

export interface WarmResult {
  ok: boolean;
  /** Why not, in words for staff. */
  problem?: string;
  /** How long the first part took to arrive. */
  firstMs: number;
  /** Seconds of video per second of waiting, over the next parts (only measured after a slow start). */
  speed?: number;
}

/** A slow first part means the picture is being converted: only then is the speed measured. */
const SLOW_START_MS = 3000;

interface Segment {
  url: string;
  sec: number;
  start: number;
}

function segments(text: string, base: string): Segment[] {
  const out: Segment[] = [];
  let sec = 0;
  let at = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const inf = /^#EXTINF:([0-9.]+)/.exec(line);
    if (inf) sec = Number(inf[1]) || 0;
    if (line.startsWith("#")) continue;
    out.push({ url: new URL(line, base).toString(), sec, start: at });
    at += sec;
    sec = 0;
  }
  return out;
}

export async function warmHls(http: Http, url: string, startAt = 0, o: { now?: () => number; firstTimeoutMs?: number; slowStartMs?: number } = {}): Promise<WarmResult> {
  const now = o.now ?? Date.now;
  const get = (u: string, timeoutMs: number) => http({ url: u, headers: { accept: "*/*" }, timeoutMs, maxBytes: 160 * 1024 * 1024 });
  const t0 = now();
  const fail = (problem: string): WarmResult => ({ ok: false, problem, firstMs: now() - t0 });
  try {
    const master = await get(url, 20_000);
    if (master.status !== 200) return fail(`the server answered ${master.status} for the stream`);
    const variant = master
      .text()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (!variant) return fail("the server's stream was empty");
    const vUrl = new URL(variant, url).toString();
    const media = await get(vUrl, 20_000);
    if (media.status !== 200) return fail(`the server answered ${media.status} for the stream`);
    const segs = segments(media.text(), vUrl);
    if (!segs.length) return fail("the server's stream was empty");
    let i = segs.findIndex((s) => s.start + s.sec > startAt);
    if (i < 0) i = 0;
    const first = await get(segs[i]!.url, o.firstTimeoutMs ?? 50_000);
    const firstMs = now() - t0;
    if (first.status !== 200) return { ok: false, problem: `the server couldn't convert it (it answered ${first.status})`, firstMs };
    if (firstMs < (o.slowStartMs ?? SLOW_START_MS) || i + 2 >= segs.length) return { ok: true, firstMs };
    // Time the next two parts: the server makes them while we wait.
    const t1 = now();
    let sec = 0;
    for (const s of segs.slice(i + 1, i + 3)) {
      const r = await get(s.url, 40_000);
      if (r.status !== 200) return { ok: false, problem: `the server stopped converting it (it answered ${r.status})`, firstMs };
      sec += s.sec;
    }
    const took = Math.max(1, now() - t1) / 1000;
    return { ok: true, firstMs, ...(sec > 0 ? { speed: sec / took } : {}) };
  } catch (err) {
    if (err instanceof HttpError && err.kind === "timeout") return fail("the server took too long to start converting it");
    return fail(err instanceof HttpError ? err.message : "the stream couldn't be read");
  }
}
