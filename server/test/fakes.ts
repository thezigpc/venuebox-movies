// Test doubles: a fake Jellyfin (the parts the app uses, served under any base path), a fake
// box core, and a controllable fake TV. Tests never talk to a real media server.

import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { BarGames } from "@bargames/sdk/server";
import { createApp, type MoviesApp } from "../src/app.js";
import { makeBarGames } from "../src/bargames.js";
import { createHttp } from "../src/http.js";
import type { PlayVideoArgs, VideoAction, VideoOut, VideoStatus, VideoTv } from "../src/video.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CERT = readFileSync(path.join(here, "fixtures/selfsigned.crt"));
export const KEY = readFileSync(path.join(here, "fixtures/selfsigned.key"));

export const USER = "movies";
export const PASSWORD = "right-password";
export const TOKEN = "jf-token-0123456789abcdef";
export const ADMIN_PW = "admin-password-123";

type J = Record<string, unknown>;

const stream = (type: string, codec: string, extra: J = {}) => ({ Type: type, Codec: codec, ...extra });
const MOVIES: J[] = [
  {
    Id: "m1",
    Name: "Big Movie",
    Type: "Movie",
    ProductionYear: 2021,
    RunTimeTicks: 7200 * 1e7,
    Overview: "A 4K HDR movie.",
    ImageTags: { Primary: "t" },
    UserData: { Played: false, PlaybackPositionTicks: 600 * 1e7, PlayedPercentage: 8 },
    MediaSources: [{ Id: "m1", Container: "mov,mp4,m4a,3gp,3g2,mj2", Bitrate: 40_000_000, MediaStreams: [stream("Video", "hevc", { Width: 3840, Height: 2160, VideoRangeType: "HDR10" }), stream("Audio", "eac3", { Channels: 6, Index: 1 })], DefaultAudioStreamIndex: 1 }],
  },
  {
    Id: "m2",
    Name: "Plain Movie",
    Type: "Movie",
    ProductionYear: 2010,
    RunTimeTicks: 5400 * 1e7,
    ImageTags: { Primary: "t" },
    UserData: { Played: true },
    MediaSources: [{ Id: "m2", Container: "mkv", Bitrate: 8_000_000, MediaStreams: [stream("Video", "h264", { Width: 1920, Height: 1080, VideoRangeType: "SDR" }), stream("Audio", "ac3", { Channels: 6, Index: 1 })], DefaultAudioStreamIndex: 1 }],
  },
];
const EPISODES: J[] = [1, 2, 3].map((n) => ({
  Id: `e${n}`,
  Name: `Episode ${n}`,
  Type: "Episode",
  SeriesId: "s1",
  SeriesName: "The Show",
  SeasonId: "se1",
  ParentIndexNumber: 1,
  IndexNumber: n,
  RunTimeTicks: 1800 * 1e7,
  UserData: { Played: n === 1 },
  MediaSources: [{ Id: `e${n}`, Container: "mkv", Bitrate: 3_000_000, MediaStreams: [stream("Video", "h264", { Width: 1280, Height: 720 }), stream("Audio", "aac", { Channels: 2, Index: 1 })], DefaultAudioStreamIndex: 1 }],
}));
const OTHER: J[] = [
  { Id: "s1", Name: "The Show", Type: "Series", ProductionYear: 2015, ImageTags: { Primary: "t" } },
  { Id: "se1", Name: "Season 1", Type: "Season", SeriesId: "s1", SeriesName: "The Show" },
  { Id: "b1", Name: "Movie Night", Type: "BoxSet", ChildCount: 2 },
  { Id: "lib-movies", Name: "Movies", Type: "CollectionFolder", CollectionType: "movies" },
  { Id: "lib-shows", Name: "Shows", Type: "CollectionFolder", CollectionType: "tvshows" },
  { Id: "lib-music", Name: "Music", Type: "CollectionFolder", CollectionType: "music" },
];
const ALL = [...MOVIES, ...EPISODES, ...OTHER];
const byId = (id: string) => ALL.find((x) => x.Id === id);

export interface FakeJellyfin {
  url: string;
  /** Every request's method, path and Authorization header. */
  requests: { method: string; path: string; auth: string; body: J | null }[];
  reports: { kind: string; body: J }[];
  serverId: string;
  isAdmin: boolean;
  close(): Promise<void>;
}

/** A pretend Jellyfin. basePath: served under it (a reverse proxy's /jellyfin). tls: https with the self-signed fixture. */
export async function fakeJellyfin(o: { basePath?: string; tls?: boolean } = {}): Promise<FakeJellyfin> {
  const base = o.basePath ?? "";
  const jf: FakeJellyfin = { url: "", requests: [], reports: [], serverId: "server-1", isAdmin: false, close: async () => undefined };
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      const auth = String(req.headers.authorization ?? "");
      const body = raw ? (JSON.parse(raw) as J) : null;
      jf.requests.push({ method: req.method ?? "", path: u.pathname + u.search, auth, body });
      const json = (v: unknown, status = 200) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(v)));
      if (!u.pathname.startsWith(`${base}/`)) return void res.writeHead(404).end();
      const p = u.pathname.slice(base.length);
      const q = u.searchParams;

      if (p === "/System/Info/Public") return json({ ServerName: "Fake Jellyfin", Version: "10.11.0", ProductName: "Jellyfin Server", Id: jf.serverId });
      if (p === "/Users/AuthenticateByName" && req.method === "POST") {
        if (body?.Username !== USER || body?.Pw !== PASSWORD) return void res.writeHead(401).end("Error processing request.");
        return json({ AccessToken: TOKEN, ServerId: jf.serverId, User: { Id: "u1", Name: USER, Policy: { IsAdministrator: jf.isAdmin } } });
      }
      if (p.startsWith("/Items/") && p.endsWith("/Images/Primary")) {
        if (!byId(p.split("/")[2]!)) return void res.writeHead(404).end();
        res.writeHead(200, { "content-type": "image/jpeg" });
        return void res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
      }
      // Everything else needs our token.
      if (!auth.includes(`Token="${TOKEN}"`)) return void res.writeHead(401).end();
      if (p === "/Sessions/Logout") return void res.writeHead(204).end();
      if (p === "/Users/Me") return json({ Name: USER, Policy: { IsAdministrator: jf.isAdmin } });
      if (p === "/UserViews") return json({ Items: OTHER.filter((x) => x.Type === "CollectionFolder") });
      if (p.startsWith("/Sessions/Playing")) {
        jf.reports.push({ kind: p.replace("/Sessions/Playing", "") || "/Start", body: body ?? {} });
        return void res.writeHead(204).end();
      }
      if (p === "/Videos/ActiveEncodings" && req.method === "DELETE") {
        jf.reports.push({ kind: "/Encodings", body: { playSessionId: q.get("playSessionId") } });
        return void res.writeHead(204).end();
      }
      if (p === "/Items") {
        const types = (q.get("includeItemTypes") ?? "").split(",").filter(Boolean);
        let items = ALL.filter((x) => !types.length || types.includes(String(x.Type)));
        const parent = q.get("parentId");
        if (parent === "lib-movies") items = items.filter((x) => x.Type === "Movie");
        else if (parent === "lib-shows") items = items.filter((x) => x.Type === "Series" || x.Type === "Episode");
        else if (parent === "b1") items = MOVIES;
        const term = q.get("searchTerm");
        if (term) items = items.filter((x) => String(x.Name).toLowerCase().includes(term.toLowerCase()));
        const start = Number(q.get("startIndex") ?? 0);
        const limit = Number(q.get("limit") ?? 100);
        return json({ Items: items.slice(start, start + limit), TotalRecordCount: items.length });
      }
      const pb = /^\/Items\/([^/]+)\/PlaybackInfo$/.exec(p);
      if (pb && req.method === "POST") {
        const it = byId(pb[1]!) as J | undefined;
        const src = (it?.MediaSources as J[] | undefined)?.[0];
        if (!src) return json({ ErrorCode: "NoCompatibleStream" });
        const prof = (body?.DeviceProfile ?? {}) as { DirectPlayProfiles?: { Container: string; VideoCodec: string; AudioCodec: string }[]; TranscodingProfiles?: { Container: string }[] };
        const streams = src.MediaStreams as J[];
        const v = streams.find((s) => s.Type === "Video");
        const a = streams.find((s) => s.Type === "Audio");
        const cont = String(src.Container).split(",");
        const dp = (prof.DirectPlayProfiles ?? []).some((d) => cont.some((c) => d.Container.split(",").includes(c)) && d.VideoCodec.split(",").includes(String(v?.Codec)) && d.AudioCodec.split(",").includes(String(a?.Codec)));
        const withinRate = Number(src.Bitrate) <= Number(body?.MaxStreamingBitrate ?? Infinity);
        const direct = dp && withinRate && body?.EnableDirectPlay !== false;
        const seg = prof.TranscodingProfiles?.[0]?.Container ?? "ts";
        return json({
          PlaySessionId: `ps-${pb[1]}-${jf.requests.length}`,
          MediaSources: [
            {
              ...src,
              SupportsDirectPlay: direct,
              SupportsTranscoding: true,
              ...(direct ? {} : { TranscodingUrl: `/videos/${pb[1]}/master.m3u8?MediaSourceId=${pb[1]}&SegmentContainer=${seg}&VideoBitrate=${body?.MaxStreamingBitrate}&ApiKey=${TOKEN}`, TranscodeReasons: dp ? ["ContainerBitrateExceedsLimit"] : ["ContainerNotSupported"] }),
            },
          ],
        });
      }
      const ep = /^\/Shows\/([^/]+)\/(Episodes|Seasons)$/.exec(p);
      if (ep) {
        if (ep[2] === "Seasons") return json({ Items: OTHER.filter((x) => x.Type === "Season") });
        return json({ Items: EPISODES });
      }
      const item = /^\/Items\/([^/]+)$/.exec(p);
      if (item) {
        const it = byId(item[1]!);
        return it ? json(it) : void res.writeHead(404).end();
      }
      res.writeHead(404).end();
    });
  };
  const srv = o.tls ? https.createServer({ cert: CERT, key: KEY }, handler) : http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  jf.url = `${o.tls ? "https" : "http"}://127.0.0.1:${(srv.address() as AddressInfo).port}${base}`;
  jf.close = () => new Promise((r) => (srv.close(() => r()), srv.closeAllConnections()));
  return jf;
}

// ------------------------------------------------------------------ fake TVs

export class FakeTvs implements VideoOut {
  readonly fake = true;
  plays: { displayId: string; args: PlayVideoArgs }[] = [];
  controls: { displayId: string; action: VideoAction }[] = [];
  statuses = new Map<string, VideoStatus>();
  playAnswer: { ok: boolean; reason?: string; message?: string } = { ok: true };
  list: VideoTv[] = [
    { id: "atv", name: "Bar Apple TV", kind: "appletv", model: "AppleTV4KGen3", online: true },
    { id: "roku", name: "Patio Roku", kind: "roku", model: "3930X", online: true },
  ];
  problem = () => null;
  tvs = async () => this.list;
  async play(displayId: string, args: PlayVideoArgs) {
    this.plays.push({ displayId, args });
    if (this.playAnswer.ok) this.statuses.set(displayId, { state: "stopped" });
    return this.playAnswer;
  }
  async control(displayId: string, action: VideoAction) {
    this.controls.push({ displayId, action });
    return { ok: true };
  }
  async status(displayId: string) {
    return this.statuses.get(displayId) ?? { state: "stopped" as const };
  }
}

// ------------------------------------------------------------------ fake box core

export const CORE_TOKEN = "core-token";

export interface FakeCore {
  url: string;
  events: { type: string; data?: Record<string, unknown> }[];
  tvs: unknown[];
  close(): Promise<void>;
}

export async function fakeCore(): Promise<FakeCore> {
  const theme = { colors: { background: "#000000", surface: "#111111", text: "#ffffff", primary: "#ff0000", accent: "#00ff00" } };
  const core: FakeCore = { url: "", events: [], tvs: [], close: async () => undefined };
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${CORE_TOKEN}`) return void res.writeHead(401).end();
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const json = (v: unknown) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(v)));
      if (req.url === "/internal/venue") return json({ protocol: 1, venue: { name: "The Root Bar", theme, timezone: "America/New_York" }, game: { id: "movies", displayName: "Movies", theme }, standalone: false, generatedAt: new Date().toISOString() });
      if (req.url === "/internal/tvs") return json({ tvs: core.tvs });
      if (req.url === "/internal/events") {
        for (const e of Array.isArray(body.events) ? body.events : [body]) core.events.push(e);
        return void res.writeHead(204).end();
      }
      if (req.url === "/internal/attention") return json({ ok: true });
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  core.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  core.close = () => new Promise((r) => (srv.close(() => r()), srv.closeAllConnections()));
  return core;
}

// ------------------------------------------------------------------ the app

export interface TestApp {
  url: string;
  app: MoviesApp;
  bg: BarGames;
  tvs: FakeTvs;
  dir: string;
  logs: string[];
  token: string;
  api<T = J>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

export async function startApp(o: { core?: FakeCore; video?: VideoOut } = {}): Promise<TestApp> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "movies-test-"));
  const bg = makeBarGames({ defaultName: "Movies", ...(o.core ? { coreUrl: o.core.url, token: CORE_TOKEN } : {}) });
  const tvs = new FakeTvs();
  const app = await createApp({ dataDir: dir, bg, adminPassword: ADMIN_PW, video: o.video ?? tvs, http: createHttp(), pollMs: 60_000 });
  const server = http.createServer(app.app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${url}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: ADMIN_PW }) });
  const token = ((await login.json()) as { token: string }).token;
  const t: TestApp = {
    url,
    app,
    bg,
    tvs,
    dir,
    logs: [],
    token,
    async api(method, p, body) {
      const r = await fetch(url + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as never };
    },
    async close() {
      await app.close();
      await new Promise((r) => (server.close(r), server.closeAllConnections()));
      await rm(dir, { recursive: true, force: true });
    },
  };
  return t;
}

/** Sets the server address and signs in. */
export async function connect(t: TestApp, jf: FakeJellyfin): Promise<void> {
  const a = await t.api("PUT", "/api/admin/server", { url: jf.url });
  if (a.status !== 200) throw new Error(`server: ${JSON.stringify(a.body)}`);
  const s = await t.api("POST", "/api/admin/server/signin", { username: USER, password: PASSWORD });
  if (s.status !== 200) throw new Error(`signin: ${JSON.stringify(s.body)}`);
}
