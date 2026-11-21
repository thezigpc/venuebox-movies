// What each TV is playing. One session per box TV: the queue (one movie, a series from the next
// episode, a collection), the current stream's play session, and the TV's state as the TV
// reports it (polled through the box). Reports start, progress and stop to the media server
// so its "now playing" and resume points stay right. Emits video_started / video_stopped,
// with the TV's name and the title only: never a link.

import { effectiveProfile, profileFor, type NowPlaying, type TvInfo, type TvProfileId, type TvState } from "@movies/shared";
import { log } from "./log.js";
import type { MediaSource, PlaySession } from "./sources/types.js";
import { SourceError } from "./sources/types.js";
import type { Store } from "./store.js";
import type { VideoAction, VideoOut, VideoTv } from "./video.js";
import { problemWords, reasonWords } from "./video.js";

/** A Roku's built-in player can't seek or start part-way through (box 0.27.0). */
export const canSeek = (tv: { kind: string }) => tv.kind !== "roku";

export class PlayError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

interface Current {
  itemId: string;
  title: string;
  subtitle?: string;
  poster?: string;
  durationSec?: number;
  session: PlaySession;
  state: TvState;
  position: number;
  startedAt: number;
  /** The TV said playing or paused at least once. */
  seen: boolean;
  lastReportAt: number;
  lastReported: string;
}

interface Session {
  displayId: string;
  tvName: string;
  /** What staff picked (a movie, a series, a collection): the box's status itemId. */
  originId: string;
  label: string;
  queue: string[];
  index: number;
  current: Current | null;
  /** Shown for a while after something went wrong. */
  message?: string;
  messageUntil?: number;
}

export interface PlayerOptions {
  source: () => MediaSource;
  video: VideoOut;
  store: Store;
  emit: (type: "video_started" | "video_stopped", data: Record<string, unknown>) => void;
  now?: () => number;
  pollMs?: number;
  progressMs?: number;
  /** A TV that hasn't started playing after this long is an error. */
  startTimeoutMs?: number;
}

export interface PlayOptions {
  /** Start from the server's resume point (part-watched). Default true. */
  resume?: boolean;
}

export class Player {
  private sessions = new Map<string, Session>();
  private tvCache: VideoTv[] = [];
  private tvCacheAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly o: PlayerOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.o.pollMs ?? 4000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Leave the TVs playing; tell the server where each one was so resume points are right.
    for (const s of this.sessions.values()) if (s.current) await this.report("stop", s.current).catch(() => undefined);
  }

  // ---------------------------------------------------------------- TVs

  async tvs(force = false): Promise<VideoTv[]> {
    if (!force && this.now() - this.tvCacheAt < 15_000) return this.tvCache;
    try {
      this.tvCache = await this.o.video.tvs();
      this.tvCacheAt = this.now();
    } catch (err) {
      log.warn("player", "couldn't read the box's TVs", { err: String(err) });
    }
    return this.tvCache;
  }

  /** Cached TVs (status providers must answer at once). */
  cachedTvs(): VideoTv[] {
    return this.tvCache;
  }

  profileOf(tv: VideoTv): { id: TvProfileId; auto: boolean } {
    const set = this.o.store.tv(tv.id).profile;
    return set ? { id: set, auto: false } : { id: profileFor({ kind: tv.kind, model: tv.model }), auto: true };
  }

  info(tv: VideoTv): TvInfo {
    const st = this.o.store.tv(tv.id);
    const p = this.profileOf(tv);
    return {
      displayId: tv.id,
      name: tv.name,
      ...(tv.group ? { group: tv.group } : {}),
      kind: tv.kind,
      ...(tv.model ? { model: tv.model } : {}),
      online: tv.online,
      profile: p.id,
      profileAuto: p.auto,
      capMbps: st.capMbps,
      allow4k: st.allow4k,
      canSeek: canSeek(tv),
      now: this.nowPlaying(tv.id),
    };
  }

  nowPlaying(displayId: string): NowPlaying | null {
    const s = this.sessions.get(displayId);
    if (!s) return null;
    const c = s.current;
    if (!c) {
      if (s.message && (s.messageUntil ?? 0) > this.now()) return { itemId: s.originId, title: s.label, state: "error", positionSec: 0, method: "direct", message: s.message };
      return null;
    }
    const left = s.queue.length - s.index - 1;
    return {
      itemId: c.itemId,
      title: c.title,
      ...(c.subtitle ? { subtitle: c.subtitle } : {}),
      ...(c.poster ? { poster: c.poster } : {}),
      state: c.state,
      positionSec: Math.round(c.position),
      ...(c.durationSec ? { durationSec: c.durationSec } : {}),
      method: c.session.method,
      ...(left > 0 ? { upNext: `${left} more from ${s.label}` } : {}),
      ...(s.message ? { message: s.message } : {}),
    };
  }

  /** The box's view of a TV: linked (ready) | starting | playing | paused | error. */
  mediaState(displayId: string): "linked" | "starting" | "playing" | "paused" | "error" {
    const s = this.sessions.get(displayId);
    if (!s) return "linked";
    if (!s.current) return s.message && (s.messageUntil ?? 0) > this.now() ? "error" : "linked";
    const st = s.current.state;
    return st === "playing" || st === "paused" || st === "starting" || st === "error" ? st : "linked";
  }

  originOf(displayId: string): string | undefined {
    return this.sessions.get(displayId)?.originId;
  }

  // ---------------------------------------------------------------- play

  /** Plays a movie, episode, series, season, collection or library on a TV. */
  async play(displayId: string, itemId: string, opts: PlayOptions = {}): Promise<{ title: string; method: "direct" | "transcode"; reasons: string[] }> {
    const problem = this.o.video.problem();
    if (problem) throw new PlayError(problemWords(problem));
    const tv = (await this.tvs()).find((t) => t.id === displayId) ?? (await this.tvs(true)).find((t) => t.id === displayId);
    if (!tv) throw new PlayError("The box doesn't know that TV, or it can't play videos.", 404);
    if (!tv.online) throw new PlayError(`${tv.name} is offline.`);
    const source = this.o.source();
    const q = await source.queue(itemId);
    if (!q.ids.length) throw new PlayError("There's nothing to play in that.");
    // A new pick replaces whatever was on that TV.
    await this.end(displayId, { emit: false, stopTv: false });
    const s: Session = { displayId, tvName: tv.name, originId: itemId, label: q.label, queue: q.ids, index: 0, current: null };
    this.sessions.set(displayId, s);
    try {
      return await this.startCurrent(s, tv, opts.resume !== false);
    } catch (err) {
      this.sessions.delete(displayId);
      throw err;
    }
  }

  private async startCurrent(s: Session, tv: VideoTv, resume: boolean) {
    const source = this.o.source();
    const id = s.queue[s.index]!;
    const item = await source.item(id);
    const st = this.o.store.tv(tv.id);
    const profile = effectiveProfile(this.profileOf(tv).id, { capMbps: st.capMbps, allow4k: st.allow4k });
    // A Roku's built-in player always starts from the beginning (and can't seek).
    const startAt = resume && canSeek(tv) && item.resumeSec && item.resumeSec > 30 ? item.resumeSec : undefined;
    const pb = await source.playback(id, profile, { startAt });
    const title = item.kind === "episode" && item.seriesTitle ? `${item.seriesTitle}: ${item.title}` : item.title;
    const poster = source.tvPosterUrl(id);
    const r = await this.o.video.play(tv.id, { url: pb.url, mime: pb.mime, title, ...(poster ? { poster } : {}), ...(pb.startAt ? { startAt: pb.startAt } : {}) });
    if (!r.ok) throw new PlayError(r.message || reasonWords(r.reason) || `${tv.name} didn't take the video${r.reason ? ` (${r.reason})` : ""}.`);
    const now = this.now();
    s.message = undefined;
    s.current = {
      itemId: id,
      title,
      ...(item.subtitle && item.kind === "episode" ? { subtitle: item.subtitle } : {}),
      ...(item.poster ? { poster: item.poster } : {}),
      ...(item.runtimeSec ? { durationSec: item.runtimeSec } : {}),
      session: pb.session,
      state: "starting",
      position: pb.startAt ?? 0,
      startedAt: now,
      seen: false,
      lastReportAt: now,
      lastReported: "",
    };
    log.info("player", "playing", { tv: tv.name, title, method: pb.session.method, why: pb.reasons.join("; ") || undefined, startAt: pb.startAt });
    await source.reportStart(pb.session, { positionSec: pb.startAt ?? 0 }).catch((err) => log.warn("player", "report start failed", { err: String(err) }));
    this.o.emit("video_started", { tv: tv.name, title });
    return { title, method: pb.session.method, reasons: pb.reasons };
  }

  async control(displayId: string, action: "pause" | "resume" | "stop" | "forward" | "back" | { seek: number }): Promise<void> {
    const s = this.sessions.get(displayId);
    if (action === "stop") {
      if (!s) {
        // Not ours (a restart, or someone else's): still ask the TV to stop.
        const r = await this.o.video.control(displayId, "stop");
        if (!r.ok) throw new PlayError(r.message || "The TV didn't stop.");
        return;
      }
      await this.end(displayId, { emit: true, stopTv: true });
      return;
    }
    const c = s?.current;
    if (!c) throw new PlayError("Nothing is playing on that TV.");
    let a: VideoAction;
    if (typeof action === "object" || action === "forward" || action === "back") {
      const tv = (await this.tvs()).find((t) => t.id === displayId);
      if (tv && !canSeek(tv)) throw new PlayError(`${tv.name} can't skip: a Roku's player doesn't seek.`);
    }
    if (action === "forward" || action === "back") {
      const to = Math.max(0, c.position + (action === "forward" ? 30 : -30));
      a = { seek: c.durationSec ? Math.min(to, c.durationSec - 5) : to };
    } else a = action;
    const r = await this.o.video.control(displayId, a);
    if (!r.ok) throw new PlayError(r.message || "The TV didn't do that.");
    if (a === "pause") c.state = "paused";
    else if (a === "resume") c.state = "playing";
    else if (typeof a === "object") c.position = a.seek;
    await this.report("progress", c);
  }

  /** Ends a TV's session: tells the server where it stopped, optionally stops the TV. */
  async end(displayId: string, o: { emit: boolean; stopTv: boolean; message?: string }): Promise<void> {
    const s = this.sessions.get(displayId);
    if (!s) return;
    this.sessions.delete(displayId);
    if (o.stopTv) {
      const r = await this.o.video.control(displayId, "stop").catch((err) => ({ ok: false, message: String(err) }));
      if (!r.ok) log.warn("player", "the TV didn't stop", { tv: s.tvName, message: r.message });
    }
    if (s.current) await this.report("stop", s.current);
    if (o.message) this.sessions.set(displayId, { ...s, current: null, message: o.message, messageUntil: this.now() + 120_000 });
    if (o.emit) this.o.emit("video_stopped", { tv: s.tvName });
  }

  private async report(kind: "progress" | "stop", c: Current): Promise<void> {
    const source = this.o.source();
    const p = { positionSec: c.position, paused: c.state === "paused" };
    c.lastReportAt = this.now();
    c.lastReported = `${c.state}`;
    try {
      if (kind === "stop") await source.reportStop(c.session, p);
      else await source.reportProgress(c.session, p);
    } catch (err) {
      if (!(err instanceof SourceError && err.kind === "not-found")) log.warn("player", `report ${kind} failed`, { err: String(err) });
    }
  }

  // ---------------------------------------------------------------- polling

  /** One pass over the TVs that are playing something (the timer calls it; tests too). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const s of [...this.sessions.values()]) await this.pollOne(s).catch((err) => log.warn("player", "status failed", { tv: s.tvName, err: String(err) }));
    } finally {
      this.ticking = false;
    }
  }

  private async pollOne(s: Session): Promise<void> {
    const c = s.current;
    if (!c) {
      if ((s.messageUntil ?? 0) <= this.now()) this.sessions.delete(s.displayId);
      return;
    }
    const st = await this.o.video.status(s.displayId);
    if (this.sessions.get(s.displayId) !== s || s.current !== c) return; // replaced meanwhile
    const now = this.now();
    if (typeof st.position === "number") c.position = st.position;
    if (st.duration && st.duration > 0) c.durationSec = Math.round(st.duration);

    if (st.state === "playing" || st.state === "paused") {
      c.seen = true;
      const changed = c.state !== st.state;
      c.state = st.state;
      if (changed || now - c.lastReportAt >= (this.o.progressMs ?? 10_000)) await this.report("progress", c);
      return;
    }
    if (st.state === "error") {
      log.warn("player", "the TV reported an error", { tv: s.tvName, title: c.title, message: st.message });
      await this.end(s.displayId, { emit: true, stopTv: false, message: st.message ? `The TV couldn't play it: ${st.message}` : "The TV couldn't play it." });
      return;
    }
    // stopped
    if (!c.seen) {
      if (now - c.startedAt < (this.o.startTimeoutMs ?? 45_000)) return; // still starting
      log.warn("player", "the TV never started", { tv: s.tvName, title: c.title });
      await this.end(s.displayId, { emit: true, stopTv: false, message: "The TV didn't start playing. Check it's on and try again." });
      return;
    }
    const nearEnd = c.durationSec ? c.position >= c.durationSec - Math.min(120, c.durationSec * 0.05) : false;
    if (nearEnd) {
      // Finished: the server marks it watched; go on to the next one in the queue.
      if (c.durationSec) c.position = c.durationSec;
      await this.report("stop", c);
      s.current = null;
      if (s.index + 1 < s.queue.length) {
        s.index += 1;
        const tv = (await this.tvs()).find((t) => t.id === s.displayId);
        if (tv) {
          try {
            await this.startCurrent(s, tv, false);
            return;
          } catch (err) {
            log.warn("player", "next in the queue didn't start", { tv: s.tvName, err: String(err) });
          }
        }
      }
      this.sessions.delete(s.displayId);
      this.o.emit("video_stopped", { tv: s.tvName });
      return;
    }
    // Stopped part-way on the TV itself (its remote): keep the resume point, let go.
    log.info("player", "stopped on the TV", { tv: s.tvName, title: c.title, position: Math.round(c.position) });
    await this.end(s.displayId, { emit: true, stopTv: false });
  }
}
