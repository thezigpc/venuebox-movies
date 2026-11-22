// What each TV is playing. One session per box TV: the queue (one movie, a series from the next
// episode, a collection), the current stream's play session, and the TV's state as the TV
// reports it (polled through the box). Reports start, progress and stop to the media server
// so its "now playing" and resume points stay right. Emits video_started / video_stopped,
// with the TV's name and the title only: never a link.

import { audioTrackId, effectiveProfile, profileFor, subtitleTrackId, trackIndexOf, type ItemDetail, type NowPlaying, type TrackChoice, type Tracks, type TvInfo, type TvProfile, type TvProfileId, type TvState } from "@movies/shared";
import { log } from "./log.js";
import type { MediaSource, PlaySession } from "./sources/types.js";
import { SourceError } from "./sources/types.js";
import type { Store } from "./store.js";
import type { VideoAction, VideoOut, VideoRemote, VideoTv } from "./video.js";
import { canSeek, problemWords, reasonWords } from "./video.js";

export { canSeek };

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
  tracks?: Tracks;
  audioIndex?: number;
  /** The subtitle on: burned in, or shown by a player that switches tracks itself. */
  subtitleIndex: number | null;
  /** The subtitle burned into the picture (only a new stream takes it away). */
  burned: number | null;
  /** The TV's player switches tracks itself (SDK 0.19.0). */
  native: boolean;
  /** The last audio and subtitle the TV reported, to spot changes made on the TV. */
  seenAudio?: string;
  seenSubtitle?: string | null;
}

/**
 * The tracks staff chose. On the item they were chosen for, the exact tracks; on the next ones
 * in a queue (a series, a collection), the same languages when the file has them.
 */
interface TrackPrefs extends TrackChoice {
  itemId: string;
  /** Another audio language than the default's (absent: each file's default). */
  audioLang?: string;
  /** Subtitles in this language (absent: none). */
  subtitleLang?: string;
}

/** What to ask for on this item, from the staff's choice. */
export function tracksFor(prefs: TrackPrefs | undefined, item: Pick<ItemDetail, "id" | "tracks">): TrackChoice {
  if (!prefs) return {};
  if (prefs.itemId === item.id) return { ...(prefs.audioIndex != null ? { audioIndex: prefs.audioIndex } : {}), subtitleIndex: prefs.subtitleIndex ?? null };
  const t = item.tracks;
  const out: TrackChoice = { subtitleIndex: null };
  if (!t) return out;
  if (prefs.audioLang) {
    const def = t.audio.find((a) => a.index === t.defaultAudio);
    if (def?.language !== prefs.audioLang) {
      const a = t.audio.find((x) => x.language === prefs.audioLang && !/commentary/i.test(x.label)) ?? t.audio.find((x) => x.language === prefs.audioLang);
      if (a) out.audioIndex = a.index;
    }
  }
  if (prefs.subtitleLang) {
    const s = t.subtitles.find((x) => x.language === prefs.subtitleLang && !x.forced) ?? t.subtitles.find((x) => x.language === prefs.subtitleLang);
    if (s) out.subtitleIndex = s.index;
  }
  return out;
}

function prefsFrom(item: Pick<ItemDetail, "id" | "tracks">, choice: TrackChoice): TrackPrefs {
  const t = item.tracks;
  const audio = choice.audioIndex != null && choice.audioIndex !== t?.defaultAudio ? t?.audio.find((a) => a.index === choice.audioIndex) : undefined;
  const sub = choice.subtitleIndex != null ? t?.subtitles.find((s) => s.index === choice.subtitleIndex) : undefined;
  return {
    itemId: item.id,
    ...(choice.audioIndex != null ? { audioIndex: choice.audioIndex } : {}),
    subtitleIndex: choice.subtitleIndex ?? null,
    ...(audio?.language ? { audioLang: audio.language } : {}),
    ...(sub?.language ? { subtitleLang: sub.language } : {}),
  };
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
  /** Audio and subtitles staff chose (absent: the defaults, no subtitles). */
  prefs?: TrackPrefs;
  /** Staff's choice before the queue's first item was looked up. */
  firstChoice?: TrackChoice;
  /** Starting or switching a stream: the poller leaves it alone (it has no current yet). */
  busy?: boolean;
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

export interface PlayOptions extends TrackChoice {
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
    // About every 2 s: the TV's own remote is read from its status (SDK 0.19.0).
    this.timer = setInterval(() => void this.tick(), this.o.pollMs ?? 2000);
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
    return set ? { id: set, auto: false } : { id: profileFor({ kind: tv.kind, model: tv.model, formats: tv.formats }), auto: true };
  }

  /** The profile a play asks the server for: the TV's type (or a Venuebox app's own formats) with its settings. */
  profile(tv: VideoTv): TvProfile {
    const st = this.o.store.tv(tv.id);
    return effectiveProfile(this.profileOf(tv).id, { capMbps: st.capMbps, allow4k: st.allow4k }, tv.formats, tv.kind);
  }

  info(tv: VideoTv): TvInfo {
    const st = this.o.store.tv(tv.id);
    const p = this.profileOf(tv);
    // The TV's own maximum (no cap), for the settings page.
    const top = effectiveProfile(p.id, {}, tv.formats, tv.kind);
    return {
      displayId: tv.id,
      name: tv.name,
      ...(tv.group ? { group: tv.group } : {}),
      kind: tv.kind,
      ...(tv.model ? { model: tv.model } : {}),
      online: tv.online,
      profile: p.id,
      profileAuto: p.auto,
      profileLabel: top.label,
      maxMbps: Math.round(top.maxBitrate / 1e6),
      maxHeight: top.maxHeight,
      capMbps: st.capMbps,
      allow4k: st.allow4k,
      canSeek: canSeek(tv),
      tracksNative: tv.formats?.tracks === true,
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
      ...(c.tracks ? { tracks: c.tracks } : {}),
      ...(c.audioIndex != null ? { audioIndex: c.audioIndex } : {}),
      subtitleIndex: c.subtitleIndex,
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
    const choice: TrackChoice = { ...(opts.audioIndex != null ? { audioIndex: opts.audioIndex } : {}), ...(opts.subtitleIndex != null ? { subtitleIndex: opts.subtitleIndex } : {}) };
    const s: Session = { displayId, tvName: tv.name, originId: itemId, label: q.label, queue: q.ids, index: 0, current: null, ...(Object.keys(choice).length ? { firstChoice: choice } : {}) };
    this.sessions.set(displayId, s);
    s.busy = true;
    try {
      return await this.startCurrent(s, tv, opts.resume !== false);
    } catch (err) {
      if (this.sessions.get(displayId) === s) this.sessions.delete(displayId);
      throw err;
    } finally {
      s.busy = false;
    }
  }

  private async startCurrent(s: Session, tv: VideoTv, resume: boolean, o: { at?: number; emit?: boolean } = {}) {
    const source = this.o.source();
    const id = s.queue[s.index]!;
    const item = await source.item(id);
    const profile = this.profile(tv);
    // Staff's choice applies to the item it was made on (the first of a series: its next
    // episode); the next ones get the same languages.
    if (s.firstChoice) {
      s.prefs = prefsFrom(item, s.firstChoice);
      s.firstChoice = undefined;
    }
    const tracks = tracksFor(s.prefs, item);
    // A Roku's built-in player always starts from the beginning (and can't seek); so does a
    // Venuebox app that says it can't seek.
    const startAt = !canSeek(tv) ? undefined : o.at != null ? (o.at > 5 ? o.at : undefined) : resume && item.resumeSec && item.resumeSec > 30 ? item.resumeSec : undefined;
    const native = tv.formats?.tracks === true;
    const pb = await source.playback(id, profile, { startAt, ...tracks, native });
    const title = item.kind === "episode" && item.seriesTitle ? `${item.seriesTitle}: ${item.title}` : item.title;
    const poster = source.tvPosterUrl(id);
    const r = await this.o.video.play(tv.id, { url: pb.url, mime: pb.mime, title, ...(poster ? { poster } : {}), ...(pb.startAt ? { startAt: pb.startAt } : {}), ...(pb.tracks ? { tracks: pb.tracks } : {}) });
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
      ...(item.tracks ? { tracks: item.tracks } : {}),
      ...(pb.audioIndex != null ? { audioIndex: pb.audioIndex } : {}),
      subtitleIndex: pb.subtitleIndex,
      burned: pb.burned,
      native,
    };
    log.info("player", "playing", { tv: tv.name, title, method: pb.session.method, why: pb.reasons.join("; ") || undefined, startAt: pb.startAt, audio: pb.audioIndex, subtitle: pb.subtitleIndex ?? undefined });
    await source.reportStart(pb.session, { positionSec: pb.startAt ?? 0 }).catch((err) => log.warn("player", "report start failed", { err: String(err) }));
    if (o.emit !== false) this.o.emit("video_started", { tv: tv.name, title });
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
      if (tv && !canSeek(tv)) throw new PlayError(`${tv.name} can't skip: its player doesn't seek.`);
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

  /**
   * Another audio track or subtitle on what's playing. The TV's own player can't switch, so the
   * stream starts again with them, at the same spot (a Roku, which can't start part-way, from
   * the beginning). The rest of a series or collection gets the same languages.
   */
  async setTracks(displayId: string, choice: TrackChoice): Promise<{ inPlace: boolean; restartedAt?: number }> {
    const s = this.sessions.get(displayId);
    const c = s?.current;
    if (!s || !c) throw new PlayError("Nothing is playing on that TV.");
    if (s.busy) throw new PlayError("That TV is still switching: try again in a moment.");
    const tv = (await this.tvs()).find((t) => t.id === displayId) ?? (await this.tvs(true)).find((t) => t.id === displayId);
    if (!tv) throw new PlayError("The box doesn't know that TV any more.", 404);
    if (choice.audioIndex != null && !c.tracks?.audio.some((a) => a.index === choice.audioIndex)) throw new PlayError("That audio track isn't in this file.", 400);
    if (choice.subtitleIndex != null && !c.tracks?.subtitles.some((t) => t.index === choice.subtitleIndex)) throw new PlayError("Those subtitles aren't in this file.", 400);
    const want = { audio: choice.audioIndex ?? c.tracks?.defaultAudio, sub: choice.subtitleIndex ?? null };
    if (c.native && (await this.switchInPlace(s, c, want))) {
      s.prefs = prefsFrom({ id: c.itemId, ...(c.tracks ? { tracks: c.tracks } : {}) }, choice);
      log.info("player", "tracks switched on the TV", { tv: tv.name, audio: want.audio, subtitle: want.sub ?? undefined });
      return { inPlace: true };
    }
    const at = canSeek(tv) ? Math.max(0, Math.round(c.position) - 3) : 0;
    const prev = s.prefs;
    s.prefs = prefsFrom({ id: c.itemId, ...(c.tracks ? { tracks: c.tracks } : {}) }, choice);
    // Tell the server where the old stream stopped (and end its transcode) before the new one.
    s.busy = true;
    await this.report("stop", c);
    s.current = null;
    try {
      await this.startCurrent(s, tv, false, { at, emit: false });
    } catch (err) {
      // Put the old choice back and the old item on again, so the TV isn't left with nothing.
      s.prefs = prev;
      log.warn("player", "changing tracks failed", { tv: tv.name, err: String(err) });
      await this.startCurrent(s, tv, false, { at, emit: false }).catch(() => undefined);
      throw err;
    } finally {
      s.busy = false;
    }
    log.info("player", "tracks changed", { tv: tv.name, audio: choice.audioIndex, subtitle: choice.subtitleIndex ?? undefined, at });
    return { inPlace: false, restartedAt: at };
  }

  /**
   * Asks a player that switches tracks itself to do it. False: it can't (the track isn't in
   * its stream, or a burned-in subtitle must go), so the stream has to start again.
   */
  private async switchInPlace(s: Session, c: Current, want: { audio?: number; sub: number | null }): Promise<boolean> {
    if (c.burned != null && want.sub !== c.burned) return false;
    if (want.audio != null && want.audio !== c.audioIndex) {
      const r = await this.o.video.control(s.displayId, { audio: audioTrackId(want.audio) });
      if (!r.ok) return false;
      c.audioIndex = want.audio;
      c.seenAudio = audioTrackId(want.audio);
    }
    if (want.sub !== c.subtitleIndex) {
      const r = await this.o.video.control(s.displayId, { subtitle: want.sub == null ? null : subtitleTrackId(want.sub) });
      if (!r.ok) return false;
      c.subtitleIndex = want.sub;
      c.seenSubtitle = want.sub == null ? null : subtitleTrackId(want.sub);
    }
    return true;
  }

  /** Something asked on the TV's own remote that only we can do (SDK 0.19.0). */
  private async remoteAsked(s: Session, c: Current, items: VideoRemote[]): Promise<void> {
    for (const a of items) {
      if (this.sessions.get(s.displayId) !== s || s.current !== c) return;
      const tv = (await this.tvs()).find((t) => t.id === s.displayId);
      if (!tv) return;
      if (a === "next" || a === "previous") {
        const to = a === "next" ? s.index + 1 : c.position > 10 || s.index === 0 ? s.index : s.index - 1;
        if (to >= s.queue.length) {
          log.info("player", "next asked on the TV: nothing after this", { tv: s.tvName });
          continue;
        }
        log.info("player", `${a} asked on the TV`, { tv: s.tvName });
        s.busy = true;
        try {
          await this.report("stop", c);
          s.current = null;
          s.index = to;
          await this.startCurrent(s, tv, false, { at: 0, emit: true });
        } catch (err) {
          log.warn("player", `${a} didn't start`, { tv: s.tvName, err: String(err) });
        } finally {
          s.busy = false;
        }
        return;
      }
      // A track the player couldn't switch to by itself: a new stream with it.
      const choice: TrackChoice = { ...(c.audioIndex != null ? { audioIndex: c.audioIndex } : {}), subtitleIndex: c.subtitleIndex };
      if ("audio" in a) {
        const i = trackIndexOf(a.audio, "audio");
        if (i == null || !c.tracks?.audio.some((t) => t.index === i)) continue;
        choice.audioIndex = i;
      } else {
        const i = a.subtitle == null ? null : trackIndexOf(a.subtitle, "subtitle");
        if (i === undefined || (i != null && !c.tracks?.subtitles.some((t) => t.index === i))) continue;
        choice.subtitleIndex = i;
      }
      await this.setTracks(s.displayId, choice).catch((err) => log.warn("player", "a track asked on the TV didn't start", { tv: s.tvName, err: String(err) }));
      return;
    }
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
    if (s.busy) return;
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

    if (c.native && (st.state === "playing" || st.state === "paused")) {
      // A change made on the TV itself (its remote or menu): follow it, and let the rest of a
      // series keep those languages.
      const audio = typeof st.audio === "string" ? st.audio : undefined;
      const sub = st.subtitle === null ? null : typeof st.subtitle === "string" ? st.subtitle : undefined;
      let changed = false;
      if (audio !== undefined && c.seenAudio !== undefined && audio !== c.seenAudio) {
        const i = trackIndexOf(audio, "audio");
        if (i != null) (c.audioIndex = i), (changed = true);
      }
      if (sub !== undefined && c.seenSubtitle !== undefined && sub !== c.seenSubtitle) {
        const i = sub == null ? null : trackIndexOf(sub, "subtitle");
        if (i !== undefined) (c.subtitleIndex = i), (changed = true);
      }
      if (audio !== undefined) c.seenAudio = audio;
      if (sub !== undefined) c.seenSubtitle = sub;
      if (changed) {
        s.prefs = prefsFrom({ id: c.itemId, ...(c.tracks ? { tracks: c.tracks } : {}) }, { ...(c.audioIndex != null ? { audioIndex: c.audioIndex } : {}), subtitleIndex: c.subtitleIndex });
        log.info("player", "tracks changed on the TV", { tv: s.tvName, audio: c.audioIndex, subtitle: c.subtitleIndex ?? undefined });
        // A burned-in subtitle can't be taken away by the player: a new stream without it.
        if (c.burned != null && c.subtitleIndex !== c.burned) {
          const tv = (await this.tvs()).find((t) => t.id === s.displayId);
          if (tv) {
            await this.setTracks(s.displayId, { ...(c.audioIndex != null ? { audioIndex: c.audioIndex } : {}), subtitleIndex: c.subtitleIndex }).catch((err) => log.warn("player", "dropping the burned-in subtitle failed", { tv: s.tvName, err: String(err) }));
            return;
          }
        }
      }
    }
    if (st.remote?.length && (st.state === "playing" || st.state === "paused")) {
      c.seen = true;
      c.state = st.state;
      await this.remoteAsked(s, c, st.remote);
      if (s.current !== c) return;
    }
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
