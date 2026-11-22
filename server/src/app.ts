import { randomUUID } from "node:crypto";
// The HTTP app: the staff picker's API (browse, search, play, now playing), the settings API
// (server address, certificate, sign-in, per-TV settings), signed poster links and the built
// client. Built by a function, so tests run it in-process with a fake Jellyfin and fake TVs.

import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { BarGames } from "@bargames/sdk/server";
import { adminRouter, createAdminAuth, createJsonStore, serveSpa, type AdminAuth } from "@bargames/gamekit/server";
import { canDirectPlay, DEFAULT_NAME, isProfileId, normaliseServerUrl, type AdminState, type CertOffer, type ServerStatus, type PublicState, type StaffState, type TestResult, type TrackChoice } from "@movies/shared";
import { venueName } from "./bargames.js";
import { VERSION } from "./config.js";
import { createHttp, normaliseFingerprint, probeCertificate, type Http } from "./http.js";
import { log } from "./log.js";
import { registerMedia } from "./media.js";
import { PlayError, Player } from "./player.js";
import { checkPosterSig, PosterCache, posterPath, POSTER_WIDTHS } from "./posters.js";
import { JellyfinSource } from "./sources/jellyfin.js";
import { SourceError, type MediaSource } from "./sources/types.js";
import { Store } from "./store.js";
import { Vote, VoteError } from "./vote.js";
import { createBoxVideo, createFakeVideo, type VideoOut } from "./video.js";

export interface AppOptions {
  dataDir: string;
  bg: BarGames;
  adminPassword?: string;
  gameName?: string;
  clientDist?: string;
  basePath?: string;
  /** Pretend TVs (dev). */
  fakeTvs?: boolean;
  /** Tests: our HTTP to the media server, and the TVs. */
  http?: Http;
  video?: VideoOut;
  now?: () => number;
  pollMs?: number;
  /** Tests: probe a certificate (no real TLS). */
  probeCert?: typeof probeCertificate;
}

export interface MoviesApp {
  app: express.Express;
  store: Store;
  auth: AdminAuth;
  player: Player;
  video: VideoOut;
  close(): Promise<void>;
}

const safe =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    void fn(req, res).catch(next);

class BadRequest extends Error {
  status = 400;
}

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Audio and subtitle choice from a request: a stream index, or null for no subtitles. */
function trackChoice(b: Record<string, unknown>): TrackChoice {
  const idx = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1000 ? v : undefined);
  const out: TrackChoice = {};
  const a = idx(b.audioIndex);
  if (a != null) out.audioIndex = a;
  if (b.subtitleIndex === null) out.subtitleIndex = null;
  else {
    const s = idx(b.subtitleIndex);
    if (s != null) out.subtitleIndex = s;
  }
  return out;
}

export async function createApp(o: AppOptions): Promise<MoviesApp> {
  const bg = o.bg;
  const store = new Store(o.dataDir);
  await store.init();

  const http = o.http ?? createHttp({ pin: () => store.settings.pin });
  const probe = o.probeCert ?? probeCertificate;

  let cachedName = store.settings.name || o.gameName || DEFAULT_NAME;
  const refreshName = () =>
    void venueName(bg)
      .then((n) => (cachedName = n ?? (store.settings.name || o.gameName || DEFAULT_NAME)))
      .catch(() => undefined);
  refreshName();

  const jellyfin = new JellyfinSource({
    http,
    baseUrl: () => store.settings.serverUrl,
    auth: () => (store.secrets.jellyfin ? { token: store.secrets.jellyfin.token, userId: store.secrets.jellyfin.userId } : null),
    deviceId: () => store.secrets.deviceId,
    deviceName: () => `Venuebox (${cachedName})`,
    version: VERSION,
    posterPath: (id) => posterPath(store.secrets.posterKey, id),
  });
  const source = (): MediaSource => jellyfin;
  /** Something the server said that staff should see (signed out, unreachable). */
  let problem: string | null = null;
  const ready = () => !!store.settings.serverUrl && !!store.secrets.jellyfin;

  const video = o.video ?? (o.fakeTvs ? createFakeVideo({ http: createHttp() }) : createBoxVideo(bg));
  const player = new Player({
    source,
    video,
    store,
    // Standard events (SDK 0.17.0), shared with other video apps. Never a link in them.
    emit: (type, data) => bg.emit({ type, data }),
    now: o.now,
    pollMs: o.pollMs,
    onFinished: (displayId) => vote.finished(displayId),
  });
  // The guest vote: the winner goes on through the same player as a staff pick.
  const vote: Vote = new Vote({
    now: o.now,
    tvName: (id) => player.cachedTvs().find((t) => t.id === id)?.name,
    isPlaying: (id) => player.nowPlaying(id) != null && player.nowPlaying(id)!.state !== "error",
    play: (displayId, itemId) => player.play(displayId, itemId, { resume: false }),
  });
  const voteTimer = setInterval(() => void vote.tick(), 2000);
  voteTimer.unref();
  player.start();
  void player.tvs(true);
  registerMedia({ bg, player, source, ready });

  const auth = createAdminAuth({
    store: createJsonStore(o.dataDir),
    envPassword: o.adminPassword ?? "",
    saltFormat: "bytes",
    // Standalone behind a tunnel a whole venue shares one public IP: no per-IP lockout.
    failsAllowed: bg.connected ? undefined : Number.POSITIVE_INFINITY,
    venuePassword: (pw, ip) => bg.checkVenuePassword(pw, ip),
    onBox: bg.connected,
  });
  await auth.init();

  // ---------------------------------------------------------------- state

  function serverStatus(): ServerStatus {
    const s = store.settings;
    const j = store.secrets.jellyfin;
    return {
      kind: "jellyfin",
      url: s.serverUrl,
      insecure: !!s.serverUrl?.startsWith("http:"),
      ...(s.serverName ? { serverName: s.serverName } : {}),
      ...(s.serverVersion ? { version: s.serverVersion } : {}),
      signedIn: !!j,
      ...(j ? { userName: j.userName, userIsAdmin: j.isAdmin } : {}),
      pinned: s.pin,
      problem,
    };
  }

  async function staffState(): Promise<StaffState> {
    const tvs = await player.tvs();
    return {
      name: cachedName,
      ready: ready(),
      server: serverStatus(),
      tvs: tvs.map((t) => player.info(t)),
      video: { problem: video.problem(), fake: video.fake },
      vote: vote.staffView(),
      tonight: store.settings.tonight,
    };
  }

  /** What guests may see: titles and progress on the TVs, and the vote. Never a link. */
  function publicState(voter?: string, staff = false): PublicState {
    const playing: PublicState["playing"] = [];
    for (const t of player.cachedTvs()) {
      const n = player.nowPlaying(t.id);
      if (!n || n.state === "error" || n.state === "idle" || n.state === "offline") continue;
      const left = n.durationSec ? Math.max(0, n.durationSec - n.positionSec) : undefined;
      playing.push({
        tv: t.name,
        title: n.title,
        ...(n.subtitle ? { subtitle: n.subtitle } : {}),
        ...(n.poster ? { poster: n.poster } : {}),
        paused: n.state === "paused",
        ...(n.durationSec ? { progress: Math.min(1, n.positionSec / n.durationSec) } : {}),
        ...(left != null && n.state === "playing" ? { endsInSec: left } : {}),
      });
    }
    return { name: cachedName, playing, tonight: store.settings.tonight, vote: vote.publicView(voter), ...(staff ? { staff: true } : {}) };
  }

  /** Runs a test; on a certificate the box doesn't trust, reads it so staff can pin it. */
  async function runTest(): Promise<TestResult> {
    const r = await jellyfin.test();
    if (r.ok) {
      store.settings.serverName = r.serverName ?? "";
      store.settings.serverVersion = r.version ?? "";
      await store.saveSettings();
      // Same server, new address (a tunnel): the sign-in carries over. Another server: it doesn't.
      const j = store.secrets.jellyfin;
      if (j && r.serverId && j.serverId && j.serverId !== r.serverId) {
        store.secrets.jellyfin = null;
        await store.saveSecrets();
        problem = "That address is a different Jellyfin server: sign in to it.";
      } else problem = null;
      const { serverId: _id, ...rest } = r;
      return rest;
    }
    const url = store.settings.serverUrl;
    if (url?.startsWith("https:")) {
      try {
        const c = await probe(url);
        if (!c.trusted && !(store.settings.pin && normaliseFingerprint(store.settings.pin) === c.fingerprint)) {
          const cert: CertOffer = { fingerprint: c.fingerprint, ...(c.subject ? { subject: c.subject } : {}), ...(c.issuer ? { issuer: c.issuer } : {}), ...(c.validTo ? { validTo: c.validTo } : {}), selfSigned: c.selfSigned, reason: c.reason };
          return { ...r, cert };
        }
      } catch {
        /* the test's own error says enough */
      }
    }
    return r;
  }

  function noteProblem(err: unknown): void {
    if (err instanceof SourceError && (err.kind === "signed-out" || err.kind === "unreachable" || err.kind === "cert")) problem = err.message;
  }

  // ---------------------------------------------------------------- HTTP

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(bg.middleware());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, configured: ready() });
  });

  app.get("/api/config", (_req, res) => {
    res.set("Cache-Control", "no-cache");
    res.json({ gameName: cachedName });
  });

  // Posters: signed links (see posters.ts), so <img> works without a sign-in header.
  const posters = new PosterCache();
  app.get(
    "/api/poster/:id",
    safe(async (req, res) => {
      const id = String(req.params.id);
      const w = Number(req.query.w);
      if (!POSTER_WIDTHS.includes(w as (typeof POSTER_WIDTHS)[number]) || !checkPosterSig(store.secrets.posterKey, id, w, String(req.query.s ?? ""))) return void res.status(404).end();
      const key = `${id}|${w}`;
      let img = posters.get(key);
      if (!img) {
        const got = ready() ? await source().poster(id, w).catch(() => null) : null;
        if (!got) return void res.status(404).end();
        img = got;
        posters.set(key, img);
      }
      res.set("Content-Type", img.contentType);
      res.set("Cache-Control", "private, max-age=86400");
      res.send(img.body);
    }),
  );

  // ---- the guest page (no sign-in): what's on, and voting
  app.get("/api/public/state", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(publicState(str(req.query.voter, 64) || undefined, bg.isStaff(req)));
  });
  app.post("/api/public/vote", express.json({ limit: "2kb" }), (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = (req.body ?? {}) as Record<string, unknown>;
    try {
      // In the building, every guest shares the venue's one address (the box tells us who is).
      const access = bg.gateway(req).access;
      vote.cast(b.voter, b.itemId, bg.clientIp(req) ?? "unknown", access === "venue-ip" || access === "local");
      res.json({ ok: true, value: publicState(typeof b.voter === "string" ? b.voter : undefined, bg.isStaff(req)) });
    } catch (err) {
      if (err instanceof VoteError) return void res.status(err.status).json({ ok: false, error: err.message });
      throw err;
    }
  });

  const admin = adminRouter({ auth, clientIp: (req) => bg.clientIp(req), trusted: (req) => bg.isStaff(req) });

  admin.get(
    "/state",
    safe(async (_req, res) => {
      const body: AdminState = { ...(await staffState()), settings: { name: store.settings.name } };
      res.set("Cache-Control", "no-store");
      res.json(body);
    }),
  );

  // ---- browsing (the staff page)
  const needReady = () => {
    if (!store.settings.serverUrl) throw new PlayError("Set up the media server in settings first.", 409);
    if (!store.secrets.jellyfin) throw new PlayError("Sign in to the media server in settings first.", 409);
  };

  admin.get(
    "/libraries",
    safe(async (_req, res) => {
      needReady();
      res.json({ ok: true, value: await source().libraries() });
    }),
  );
  admin.get(
    "/browse",
    safe(async (req, res) => {
      needReady();
      const lib = str(req.query.library, 100);
      if (!lib) throw new BadRequest("Pick a library.");
      res.json({ ok: true, value: await source().browse(lib, Number(req.query.page) || 0) });
    }),
  );
  admin.get(
    "/search",
    safe(async (req, res) => {
      needReady();
      res.json({ ok: true, value: await source().search(str(req.query.q, 100)) });
    }),
  );
  admin.get(
    "/items/:id",
    safe(async (req, res) => {
      needReady();
      const item = await source().item(String(req.params.id));
      // For each TV: plays as it is, or the server converts it (and why).
      const fit: Record<string, { direct: boolean; reasons: string[] }> = {};
      if (item.file) {
        for (const t of await player.tvs()) {
          const r = canDirectPlay(player.profile(t), item.file);
          fit[t.id] = r.ok ? { direct: true, reasons: [] } : { direct: false, reasons: r.reasons };
        }
      }
      res.json({ ok: true, value: { ...item, fit } });
    }),
  );

  // ---- playing
  admin.post(
    "/play",
    safe(async (req, res) => {
      needReady();
      const b = (req.body ?? {}) as Record<string, unknown>;
      const displayId = str(b.displayId, 200);
      const itemId = str(b.itemId, 200);
      if (!displayId || !itemId) throw new BadRequest("Pick a movie and a TV.");
      const r = await player.play(displayId, itemId, { resume: b.resume !== false, ...trackChoice(b) });
      res.json({ ok: true, value: r });
    }),
  );
  admin.post(
    "/tvs/:id/control",
    safe(async (req, res) => {
      const a = (req.body as { action?: unknown; seconds?: unknown })?.action;
      const action =
        a === "pause" || a === "resume" || a === "stop" || a === "forward" || a === "back"
          ? a
          : a === "seek" && Number.isFinite(Number((req.body as { seconds?: unknown }).seconds))
            ? { seek: Math.max(0, Number((req.body as { seconds: unknown }).seconds)) }
            : null;
      if (!action) throw new BadRequest("Unknown control.");
      await player.control(String(req.params.id), action);
      res.json({ ok: true, value: player.nowPlaying(String(req.params.id)) });
    }),
  );

  admin.get(
    "/resume",
    safe(async (_req, res) => {
      needReady();
      res.json({ ok: true, value: await source().resume() });
    }),
  );

  // ---- the guest vote (staff side)
  const voteDone = (res: express.Response) => res.json({ ok: true, value: vote.staffView() });
  admin.post(
    "/vote/options",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as { itemId?: unknown; title?: unknown };
      const itemId = str(b.itemId, 200);
      if (itemId) {
        needReady();
        vote.add(await source().item(itemId));
      } else if (str(b.title, 200)) vote.addManual(str(b.title, 200));
      else throw new BadRequest("Pick a movie, or type its name.");
      voteDone(res);
    }),
  );

  // ---- "Playing tonight": typed by staff, shown to guests. Works with no media server.
  const tonightDone = async (res: express.Response) => {
    await store.saveSettings();
    res.json({ ok: true, value: store.settings.tonight });
  };
  admin.post(
    "/tonight",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const title = str(b.title, 120);
      if (!title) throw new BadRequest("Type the movie's name.");
      if (store.settings.tonight.length >= 30) throw new BadRequest("The list is full: remove one first.");
      const when = str(b.when, 60);
      store.settings.tonight.push({ id: randomUUID(), title, ...(when ? { when } : {}), onNow: b.onNow === true });
      await tonightDone(res);
    }),
  );
  admin.put(
    "/tonight/:id",
    safe(async (req, res) => {
      const e = store.settings.tonight.find((x) => x.id === req.params.id);
      if (!e) throw new PlayError("That movie isn't on the list any more.", 404);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.onNow === "boolean") e.onNow = b.onNow;
      if (str(b.title, 120)) e.title = str(b.title, 120);
      if (typeof b.when === "string") {
        if (str(b.when, 60)) e.when = str(b.when, 60);
        else delete e.when;
      }
      await tonightDone(res);
    }),
  );
  admin.delete(
    "/tonight/:id",
    safe(async (req, res) => {
      store.settings.tonight = store.settings.tonight.filter((x) => x.id !== req.params.id);
      await tonightDone(res);
    }),
  );
  admin.delete(
    "/vote/options/:id",
    safe(async (req, res) => {
      vote.remove(String(req.params.id));
      voteDone(res);
    }),
  );
  admin.post(
    "/vote/open",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const closes = b.closes === "time" || b.closes === "movie-end" ? b.closes : "manual";
      await player.tvs();
      vote.start({ ...(str(b.displayId, 200) ? { displayId: str(b.displayId, 200) } : {}), closes, ...(Number.isFinite(Number(b.minutes)) ? { minutes: Number(b.minutes) } : {}), autoPlay: b.autoPlay !== false });
      voteDone(res);
    }),
  );
  admin.post(
    "/vote/close",
    safe(async (_req, res) => {
      await vote.close();
      voteDone(res);
    }),
  );
  admin.post(
    "/vote/play",
    safe(async (_req, res) => {
      await vote.playWinner();
      voteDone(res);
    }),
  );
  admin.delete(
    "/vote",
    safe(async (_req, res) => {
      vote.clear();
      voteDone(res);
    }),
  );

  admin.post(
    "/tvs/:id/tracks",
    safe(async (req, res) => {
      const choice = trackChoice((req.body ?? {}) as Record<string, unknown>);
      const r = await player.setTracks(String(req.params.id), choice);
      res.json({ ok: true, value: player.nowPlaying(String(req.params.id)), inPlace: r.inPlace });
    }),
  );

  // ---- settings
  admin.put(
    "/settings",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (b.name !== undefined) store.settings.name = str(b.name, 60);
      await store.saveSettings();
      refreshName();
      res.json({ ok: true });
    }),
  );

  admin.put(
    "/server",
    safe(async (req, res) => {
      const r = normaliseServerUrl(String((req.body as { url?: unknown })?.url ?? ""));
      if (!r.ok) throw new BadRequest(r.error);
      const old = store.settings.serverUrl;
      const origin = (u: string | null) => (u ? new URL(u).host : "");
      store.settings.serverUrl = r.url;
      // A pin belongs to one address's certificate.
      if (origin(old) !== origin(r.url) || !r.url.startsWith("https:")) store.settings.pin = null;
      if (old !== r.url) (store.settings.serverName = ""), (store.settings.serverVersion = ""), posters.clear();
      await store.saveSettings();
      const test = await runTest();
      log.info("settings", "server address set", { scheme: r.url.split(":")[0], ok: test.ok });
      res.json({ ok: true, value: { notes: r.notes, test, server: serverStatus() } });
    }),
  );
  admin.post(
    "/server/test",
    safe(async (_req, res) => {
      if (!store.settings.serverUrl) throw new BadRequest("Type the server's address first.");
      const test = await runTest();
      // With a sign-in, also check the token still works.
      if (test.ok && store.secrets.jellyfin) {
        try {
          const me = await jellyfin.me();
          store.secrets.jellyfin.isAdmin = me.isAdmin;
          await store.saveSecrets();
        } catch (err) {
          noteProblem(err);
          if (err instanceof SourceError && err.kind === "signed-out") {
            store.secrets.jellyfin = null;
            await store.saveSecrets();
          }
        }
      }
      res.json({ ok: true, value: { test, server: serverStatus() } });
    }),
  );
  admin.post(
    "/server/trust",
    safe(async (req, res) => {
      const url = store.settings.serverUrl;
      if (!url?.startsWith("https:")) throw new BadRequest("Only an https address has a certificate to trust.");
      const want = normaliseFingerprint(String((req.body as { fingerprint?: unknown })?.fingerprint ?? ""));
      if (!want) throw new BadRequest("That isn't a certificate fingerprint.");
      // Only the certificate the server shows right now, and only the one staff were shown.
      const c = await probe(url);
      if (c.fingerprint !== want) throw new BadRequest("The server's certificate changed since you looked. Test again.");
      store.settings.pin = want;
      await store.saveSettings();
      const test = await runTest();
      log.info("settings", "trusting a self-signed certificate", { fingerprint: want.slice(0, 11) });
      res.json({ ok: true, value: { test, server: serverStatus() } });
    }),
  );
  admin.delete(
    "/server/trust",
    safe(async (_req, res) => {
      store.settings.pin = null;
      await store.saveSettings();
      res.json({ ok: true, value: { server: serverStatus() } });
    }),
  );
  admin.post(
    "/server/signin",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const username = str(b.username, 200);
      const password = typeof b.password === "string" ? b.password.slice(0, 500) : "";
      if (!store.settings.serverUrl) throw new BadRequest("Type the server's address first.");
      if (!username) throw new BadRequest("Type the Jellyfin user name.");
      const test = await jellyfin.test();
      if (!test.ok) throw new BadRequest(test.error ?? "The server didn't answer.");
      // Sign out the old token first, so the server doesn't keep a stale device.
      if (store.secrets.jellyfin) await jellyfin.signOut();
      const r = await jellyfin.signIn(username, password);
      store.secrets.jellyfin = { token: r.token, userId: r.userId, userName: r.userName, isAdmin: r.isAdmin, serverId: r.serverId || test.serverId || "" };
      await store.saveSecrets();
      problem = null;
      log.info("settings", "signed in to the media server", { user: r.userName, admin: r.isAdmin });
      res.json({ ok: true, value: { server: serverStatus() } });
    }),
  );
  admin.post(
    "/server/signout",
    safe(async (_req, res) => {
      if (store.secrets.jellyfin) await jellyfin.signOut();
      store.secrets.jellyfin = null;
      await store.saveSecrets();
      posters.clear();
      res.json({ ok: true, value: { server: serverStatus() } });
    }),
  );
  admin.put(
    "/tvs/:id",
    safe(async (req, res) => {
      const id = String(req.params.id);
      if (!(await player.tvs(true)).some((t) => t.id === id)) throw new BadRequest("The box doesn't know that TV.");
      const b = (req.body ?? {}) as Record<string, unknown>;
      const cur = { ...store.tv(id) };
      if (b.profile !== undefined) {
        if (b.profile === null || b.profile === "auto") delete cur.profile;
        else if (isProfileId(b.profile)) cur.profile = b.profile;
        else throw new BadRequest("Unknown TV type.");
      }
      if (b.capMbps !== undefined) {
        if (b.capMbps === null || b.capMbps === "") cur.capMbps = null;
        else {
          const n = Number(b.capMbps);
          if (!Number.isFinite(n) || n < 1 || n > 200) throw new BadRequest("Bitrate cap: 1 to 200 Mbit/s, or empty for none.");
          cur.capMbps = Math.round(n * 10) / 10;
        }
      }
      if (b.allow4k !== undefined) cur.allow4k = !!b.allow4k;
      store.settings.tvs[id] = cur;
      await store.saveSettings();
      res.json({ ok: true });
    }),
  );

  app.use("/api/admin", admin);
  app.use("/api", (_req, res) => void res.status(404).json({ ok: false, error: "Not found." }));

  // ---------------------------------------------------------------- client
  const indexHtml = o.clientDist ? path.join(o.clientDist, "index.html") : "";
  if (indexHtml && existsSync(indexHtml)) {
    serveSpa(app, { dist: o.clientDist!, ...(o.basePath !== undefined ? { basePath: o.basePath } : {}) });
  } else if (o.clientDist) {
    log.warn("boot", "client build not found; serving the API only", { path: o.clientDist });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SourceError) {
      noteProblem(err);
      return void res.status(err.status).json({ ok: false, error: err.message });
    }
    if (err instanceof PlayError || err instanceof BadRequest || err instanceof VoteError) return void res.status(err.status).json({ ok: false, error: err.message });
    const status = (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) log.error("http", "request failed", { err: String(err) });
    if (!res.headersSent) res.status(status).json({ ok: false, error: status === 404 ? "Not found." : status < 500 ? "Bad request." : "Something went wrong." });
  });

  // Needs attention on the box's Tonight page.
  let lastAttention = "";
  const attentionTimer = setInterval(() => {
    refreshName();
    void player.tvs(true);
    if (!bg.connected) return;
    const items = [] as { level: "warn" | "error"; message: string; actionPath: string }[];
    if (!store.settings.serverUrl || !store.secrets.jellyfin) items.push({ level: "warn", message: "Movies isn't connected to a media server yet.", actionPath: "/admin" });
    else if (problem) items.push({ level: "error", message: `Movies: ${problem}`, actionPath: "/admin" });
    const json = JSON.stringify(items);
    if (json !== lastAttention) {
      lastAttention = json;
      void bg.setAttention(items).catch(() => undefined);
    }
  }, 60_000);
  attentionTimer.unref();

  return {
    app,
    store,
    auth,
    player,
    video,
    async close() {
      clearInterval(attentionTimer);
      clearInterval(voteTimer);
      await player.close();
      auth.close();
    },
  };
}
