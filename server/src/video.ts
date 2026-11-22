// Handing a TV a video link, and reading back what it's doing. The box owns the TVs: on a box
// this is bg.playVideo / bg.videoControl / bg.videoStatus (SDK 0.17.0, box 0.27.0; Venuebox
// apps with their own player from SDK 0.18.0, box 0.28.0). The TV
// streams straight from the media server; the box only passes the link on. In dev, a fake
// stands in (MOVIES_FAKE_TVS=1).
//
// A stream link carries the media server's key: it's passed to the box and to nothing else.

import type { BarGames, VideoAction, VideoRequest, VideoResult, VideoStatus } from "@bargames/sdk/server";
import type { TvFormats, VideoProblem } from "@movies/shared";
import type { Http } from "./http.js";
import { log } from "./log.js";

export type { VideoAction, VideoResult, VideoStatus };
export type PlayVideoArgs = VideoRequest;

export interface VideoTv {
  id: string;
  name: string;
  group?: string;
  kind: string;
  model?: string;
  online: boolean;
  /** A Venuebox app's player: what it plays as it is (absent for Apple TVs and Rokus). */
  formats?: TvFormats;
}

/**
 * Skip and resume points: an Apple TV does both; a Roku's built-in player can't seek or start
 * part-way; a Venuebox app says so in its formats (seek: true).
 */
export const canSeek = (tv: { kind: string; formats?: { seek?: boolean } }): boolean =>
  tv.kind === "roku" ? false : tv.kind === "venuebox" ? tv.formats?.seek === true : true;

/** The box's formats, checked (a malformed one is dropped, so the TV gets the safe profile). */
function readFormats(f: unknown): TvFormats | undefined {
  if (!f || typeof f !== "object") return undefined;
  const o = f as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
  const containers = list(o.containers), video = list(o.video), audio = list(o.audio);
  if (!containers || !video || !audio) return undefined;
  const passthrough = list(o.passthrough), ranges = list(o.ranges);
  return {
    containers,
    video,
    audio,
    ...(typeof o.maxHeight === "number" && Number.isFinite(o.maxHeight) ? { maxHeight: o.maxHeight } : {}),
    seek: o.seek === true,
    ...(passthrough ? { passthrough } : {}),
    ...(ranges ? { ranges } : {}),
  };
}

export interface VideoOut {
  readonly fake: boolean;
  problem(): VideoProblem;
  tvs(): Promise<VideoTv[]>;
  play(displayId: string, a: PlayVideoArgs): Promise<VideoResult>;
  control(displayId: string, action: VideoAction): Promise<VideoResult>;
  status(displayId: string): Promise<VideoStatus>;
}

export function createBoxVideo(bg: BarGames): VideoOut {
  // Off a box the SDK answers playVideo with reason "unsupported"; we say why first.
  const problem = (): VideoProblem => (bg.connected ? null : "standalone");
  return {
    fake: false,
    problem,
    async tvs() {
      if (problem()) return [];
      // Only TVs the box can hand a link to carry `video` (a box before 0.27.0 sends none).
      return (await bg.tvs()).flatMap((t) => {
        if (!t.video) return [];
        const formats = readFormats(t.video.formats);
        return [{ id: t.id, name: t.name, ...(t.group ? { group: t.group } : {}), kind: t.video.kind, ...(t.video.model ? { model: t.video.model } : {}), online: t.online, ...(formats ? { formats } : {}) }];
      });
    },
    play: (displayId, a) => bg.playVideo(displayId, a),
    control: (displayId, action) => bg.videoControl(displayId, action),
    status: (displayId) => bg.videoStatus(displayId),
  };
}

/** The box's refusal reasons, in words (its message wins when it has one). */
export function reasonWords(reason?: string): string | undefined {
  switch (reason) {
    case "offline": return "The box can't reach that TV right now.";
    case "unsupported": return "That TV can't play that video link.";
    case "not-allowed": return "The venue hasn't allowed Movies to play videos: approve it on the box's Apps page.";
    case "needs-pairing": return "The Apple TV needs pairing for video first: in the box admin, Pair TV control, and type the PIN the TV shows.";
    default: return undefined;
  }
}

export function problemWords(p: VideoProblem): string {
  if (p === "standalone") return "Playing on TVs needs a Bar Games box: this copy isn't running on one.";
  return "";
}

// ------------------------------------------------------------------ dev fake

interface FakeState {
  state: VideoStatus["state"];
  position: number;
  since: number;
  title: string;
  message?: string;
}

/**
 * Pretend TVs for dev (MOVIES_FAKE_TVS=1). Each play really fetches the link, the way the
 * TV would: a direct file's first bytes, or an HLS master playlist, its first variant and
 * its first segment. So a test on the dev box proves the server hands out a link that works,
 * without any TV. It never logs the link.
 */
export function createFakeVideo(opts: { http: Http; now?: () => number; probe?: boolean }): VideoOut & { probes: Map<string, string> } {
  const now = opts.now ?? Date.now;
  const tvs: VideoTv[] = [
    { id: "fake-appletv", name: "Fake Apple TV 4K", kind: "appletv", model: "AppleTV4KGen3", online: true },
    { id: "fake-roku", name: "Fake Roku Express", kind: "roku", model: "3930X", online: true },
    {
      id: "fake-venuebox",
      name: "Fake Venuebox Android TV",
      kind: "venuebox",
      model: "Android TV 4K",
      online: true,
      formats: { containers: ["mp4", "mkv", "webm", "hls"], video: ["h264", "hevc", "vp9", "av1"], audio: ["aac", "ac3", "eac3", "opus", "flac", "mp3"], maxHeight: 2160, seek: true, passthrough: ["ac3", "eac3"], ranges: ["sdr", "hdr10", "hlg"] },
    },
    { id: "fake-other", name: "Fake other TV", kind: "chromecast", online: true },
  ];
  const states = new Map<string, FakeState>();
  const probes = new Map<string, string>();

  const position = (s: FakeState) => (s.state === "playing" ? s.position + (now() - s.since) / 1000 : s.position);

  async function probe(displayId: string, url: string, mime?: string): Promise<string> {
    const get = (u: string, range?: boolean) => opts.http({ url: u, headers: range ? { range: "bytes=0-65535", accept: "*/*" } : { accept: "*/*" }, timeoutMs: 60_000, maxBytes: 4 * 1024 * 1024 });
    const firstLine = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (mime?.includes("mpegurl")) {
      const master = await get(url);
      if (master.status !== 200) return `HLS master playlist: HTTP ${master.status}`;
      const variant = firstLine(master.text());
      if (!variant) return "HLS master playlist had no variant";
      const vUrl = new URL(variant, url).toString();
      const media = await get(vUrl);
      if (media.status !== 200) return `HLS variant playlist: HTTP ${media.status}`;
      const seg = firstLine(media.text());
      if (!seg) return "HLS variant playlist had no segment";
      const s = await get(new URL(seg, vUrl).toString());
      return s.status === 200 ? `HLS ok: first segment ${s.body.length} bytes (${s.headers["content-type"] ?? "?"})` : `HLS first segment: HTTP ${s.status}`;
    }
    const r = await get(url, true);
    return r.status === 200 || r.status === 206 ? `file ok: HTTP ${r.status}, ${r.body.length} bytes (${r.headers["content-type"] ?? "?"})` : `file: HTTP ${r.status}`;
  }

  return {
    fake: true,
    probes,
    problem: () => null,
    tvs: async () => tvs,
    async play(displayId, a) {
      if (!tvs.some((t) => t.id === displayId)) return { ok: false, reason: "unknown", message: "No such TV." };
      states.set(displayId, { state: "playing", position: a.startAt ?? 0, since: now(), title: a.title });
      if (opts.probe !== false) {
        void probe(displayId, a.url, a.mime)
          .then((r) => {
            probes.set(displayId, r);
            log.info("fake-tv", "stream check", { tv: displayId, title: a.title, result: r });
            if (!/ok/.test(r)) states.set(displayId, { state: "error", position: 0, since: now(), title: a.title, message: r });
          })
          .catch((err) => {
            probes.set(displayId, `failed: ${(err as Error).message}`);
            log.warn("fake-tv", "stream check failed", { tv: displayId, err: (err as Error).message });
            states.set(displayId, { state: "error", position: 0, since: now(), title: a.title, message: (err as Error).message });
          });
      }
      return { ok: true };
    },
    async control(displayId, action) {
      const tv = tvs.find((t) => t.id === displayId);
      if (typeof action === "object" && tv && !canSeek(tv)) return { ok: false, reason: "unsupported", message: "This TV's player can't seek." };
      const s = states.get(displayId);
      if (!s || s.state === "stopped") return { ok: false, message: "Nothing is playing there." };
      const pos = position(s);
      if (action === "pause") states.set(displayId, { ...s, state: "paused", position: pos, since: now() });
      else if (action === "resume") states.set(displayId, { ...s, state: "playing", position: pos, since: now() });
      else if (action === "stop") states.set(displayId, { ...s, state: "stopped", position: pos, since: now() });
      else states.set(displayId, { ...s, position: Math.max(0, action.seek), since: now() });
      return { ok: true };
    },
    async status(displayId) {
      const s = states.get(displayId);
      if (!s) return { state: "stopped" };
      return { state: s.state, position: Math.round(position(s)), ...(s.message ? { message: s.message } : {}) };
    },
  };
}
