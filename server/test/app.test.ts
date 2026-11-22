// Settings, browsing, playback choices and the player, against a fake Jellyfin and fake TVs.
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Card, ItemDetail, Library, Page, StaffState } from "@movies/shared";
import { connect, fakeJellyfin, PASSWORD, startApp, TOKEN, USER, type FakeJellyfin, type TestApp } from "./fakes.js";

// Every log line any test produces: none may carry the token.
const lines: string[] = [];
const orig = { log: console.log, error: console.error };
before(() => {
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
});
after(() => {
  console.log = orig.log;
  console.error = orig.error;
  const leaked = lines.filter((l) => l.includes(TOKEN) || l.includes(PASSWORD));
  assert.deepEqual(leaked, [], "a log line carried the token or the password");
});

let jf: FakeJellyfin;
let t: TestApp;
beforeEach(async () => {
  jf = await fakeJellyfin({ basePath: "/jellyfin" });
  t = await startApp();
});
afterEach(async () => {
  await t.close();
  await jf.close();
});

const state = async () => (await t.api<StaffState>("GET", "/api/admin/state")).body;

describe("settings", () => {
  test("a server under a base path: test, sign in, token kept, password not", async () => {
    const r = await t.api<{ value: { test: { ok: boolean; serverName: string; version: string }; server: { url: string; insecure: boolean } } }>("PUT", "/api/admin/server", { url: `${jf.url}/` });
    assert.equal(r.status, 200);
    assert.equal(r.body.value.server.url, jf.url, "stored normalised: no trailing slash");
    assert.equal(r.body.value.server.insecure, true);
    assert.deepEqual([r.body.value.test.ok, r.body.value.test.serverName, r.body.value.test.version], [true, "Fake Jellyfin", "10.11.0"]);
    assert.ok(jf.requests.some((q) => q.path === "/jellyfin/System/Info/Public"), "the base path is kept on every call");

    const bad = await t.api<{ error: string }>("POST", "/api/admin/server/signin", { username: USER, password: "wrong" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /didn't accept/);

    const ok = await t.api<{ value: { server: { signedIn: boolean; userName: string; userIsAdmin: boolean } } }>("POST", "/api/admin/server/signin", { username: USER, password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.value.server.signedIn, ok.body.value.server.userName, ok.body.value.server.userIsAdmin], [true, USER, false]);

    const secrets = await readFile(path.join(t.dir, "secrets.json"), "utf8");
    assert.ok(secrets.includes(TOKEN), "the token is stored");
    assert.ok(!secrets.includes(PASSWORD), "the password is never stored");
    const settings = await readFile(path.join(t.dir, "settings.json"), "utf8");
    assert.ok(!settings.includes(TOKEN));
    assert.equal((await state()).ready, true);
  });

  test("no scheme typed: assumes http and says so", async () => {
    const hostPort = jf.url.replace(/^http:\/\//, "");
    const r = await t.api<{ value: { notes: string[]; server: { url: string } } }>("PUT", "/api/admin/server", { url: hostPort });
    assert.equal(r.body.value.server.url, jf.url);
    assert.match(r.body.value.notes.join(" "), /assumes http/);
  });

  test("a bad address is refused with words", async () => {
    const r = await t.api<{ error: string }>("PUT", "/api/admin/server", { url: "ftp://x.example" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /http:\/\/ or https:\/\//);
  });

  test("the wrong port or path: not a Jellyfin server", async () => {
    const r = await t.api<{ value: { test: { ok: boolean; error: string } } }>("PUT", "/api/admin/server", { url: jf.url.replace("/jellyfin", "/nope") });
    assert.equal(r.body.value.test.ok, false);
    assert.match(r.body.value.test.error, /doesn't have that|isn't a Jellyfin/);
  });

  test("a new address for the same server keeps the sign-in; another server drops it", async () => {
    await connect(t, jf);
    // Same server reached another way (a tunnel): only the URL changes.
    const other = await fakeJellyfin({ basePath: "/jf" });
    try {
      let r = await t.api<{ value: { server: { signedIn: boolean } } }>("PUT", "/api/admin/server", { url: other.url });
      assert.equal(r.body.value.server.signedIn, true);
      other.serverId = "server-2";
      r = await t.api<{ value: { server: { signedIn: boolean; problem: string } } }>("POST", "/api/admin/server/test", {});
      assert.equal(r.body.value.server.signedIn, false);
      assert.match(r.body.value.server.problem, /different Jellyfin server/);
    } finally {
      await other.close();
    }
  });

  test("an admin user is flagged", async () => {
    jf.isAdmin = true;
    await connect(t, jf);
    assert.equal((await state()).server.userIsAdmin, true);
  });

  test("per-TV settings: profile, cap, 4K", async () => {
    let r = await t.api("PUT", "/api/admin/tvs/roku", { profile: "roku3800", capMbps: 6, allow4k: false });
    assert.equal(r.status, 200);
    let tv = (await state()).tvs.find((x) => x.displayId === "roku")!;
    assert.deepEqual([tv.profile, tv.profileAuto, tv.capMbps, tv.allow4k], ["roku3800", false, 6, false]);
    r = await t.api("PUT", "/api/admin/tvs/roku", { profile: "auto", capMbps: null });
    tv = (await state()).tvs.find((x) => x.displayId === "roku")!;
    assert.deepEqual([tv.profile, tv.profileAuto, tv.capMbps], ["roku3930", true, null]);
    assert.equal((await t.api("PUT", "/api/admin/tvs/roku", { capMbps: 0 })).status, 400);
    assert.equal((await t.api("PUT", "/api/admin/tvs/nope", { capMbps: 5 })).status, 400);
  });

  test("staff API needs a sign-in", async () => {
    const r = await fetch(`${t.url}/api/admin/state`);
    assert.equal(r.status, 401);
  });
});

describe("browsing", () => {
  beforeEach(() => connect(t, jf));

  test("libraries: movies and shows, not music", async () => {
    const r = await t.api<{ value: Library[] }>("GET", "/api/admin/libraries");
    assert.deepEqual(r.body.value.map((l) => [l.title, l.kind]), [["Movies", "movies"], ["Shows", "tvshows"]]);
  });

  test("browse a library: cards with signed posters that load", async () => {
    const r = await t.api<{ value: Page<Card> }>("GET", "/api/admin/browse?library=lib-movies");
    assert.equal(r.body.value.total, 2);
    const big = r.body.value.items.find((c) => c.id === "m1")!;
    assert.equal(big.kind, "movie");
    assert.ok(big.progress && big.progress > 0 && big.progress < 1, "part-watched shows progress");
    assert.equal(r.body.value.items.find((c) => c.id === "m2")!.played, true);
    assert.ok(big.poster?.startsWith("/api/poster/m1?w=300&s="));
    const img = await fetch(t.url + big.poster);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/jpeg");
    // A forged or changed link doesn't open anything.
    assert.equal((await fetch(t.url + big.poster!.replace("m1", "m2"))).status, 404);
    assert.equal((await fetch(`${t.url}/api/poster/m1?w=300&s=0000`)).status, 404);
    // Poster links never carry the server's address or key.
    assert.ok(!JSON.stringify(r.body).includes(jf.url) && !JSON.stringify(r.body).includes(TOKEN));
  });

  test("search", async () => {
    const r = await t.api<{ value: Card[] }>("GET", "/api/admin/search?q=plain");
    assert.deepEqual(r.body.value.map((c) => c.id), ["m2"]);
  });

  test("item: details, resume point and which TVs play it as it is", async () => {
    const r = await t.api<{ value: ItemDetail & { fit: Record<string, { direct: boolean; reasons: string[] }> } }>("GET", "/api/admin/items/m1");
    const it = r.body.value;
    assert.equal(it.resumeSec, 600);
    assert.equal(it.runtimeSec, 7200);
    assert.deepEqual(it.file?.video, { codec: "hevc", width: 3840, height: 2160, range: "HDR10" });
    assert.equal(it.fit.atv!.direct, true);
    assert.equal(it.fit.roku!.direct, false);
    assert.match(it.fit.roku!.reasons.join(), /hevc/);
  });

  test("a series lists its seasons", async () => {
    const r = await t.api<{ value: ItemDetail }>("GET", "/api/admin/items/s1");
    assert.deepEqual(r.body.value.children?.map((c) => c.kind), ["season"]);
  });

  test("not set up: browsing says so", async () => {
    await t.api("POST", "/api/admin/server/signout", {});
    const r = await t.api<{ error: string }>("GET", "/api/admin/libraries");
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Sign in/);
  });
});

describe("playing", () => {
  beforeEach(() => connect(t, jf));

  const play = (displayId: string, itemId: string, extra: Record<string, unknown> = {}) => t.api<{ value: { method: string; reasons: string[] }; error?: string }>("POST", "/api/admin/play", { displayId, itemId, ...extra });
  const last = () => t.tvs.plays.at(-1)!.args;
  const lastPlaybackInfo = () => jf.requests.filter((q) => q.path.includes("/PlaybackInfo")).at(-1)!.body!;

  test("Apple TV: a 4K HDR MP4 plays as it is, from the resume point", async () => {
    const r = await play("atv", "m1");
    assert.equal(r.status, 200);
    assert.equal(r.body.value.method, "direct");
    const a = last();
    assert.match(a.url, /^http:\/\/127\.0\.0\.1:\d+\/jellyfin\/Videos\/m1\/stream\.mp4\?static=true&/);
    assert.match(a.url, new RegExp(`api_key=${TOKEN}`));
    assert.equal(a.mime, "video/mp4");
    assert.equal(a.startAt, 600);
    assert.equal(a.title, "Big Movie");
    assert.match(a.poster ?? "", /\/jellyfin\/Items\/m1\/Images\/Primary/);
    assert.ok(!(a.poster ?? "").includes(TOKEN), "the TV's poster link has no key");
    assert.equal(lastPlaybackInfo().MaxStreamingBitrate, 80_000_000);
  });

  test("start over ignores the resume point", async () => {
    await play("atv", "m1", { resume: false });
    assert.equal(last().startAt, undefined);
  });

  test("Apple TV: an MKV gets the server's HLS", async () => {
    const r = await play("atv", "m2");
    assert.equal(r.body.value.method, "transcode");
    assert.match(last().url, /\/jellyfin\/videos\/m2\/master\.m3u8\?.*SegmentContainer=mp4/);
    assert.equal(last().mime, "application/vnd.apple.mpegurl");
    // The server's default subtitle isn't burned in (a full transcode nobody asked for).
    assert.doesNotMatch(last().url, /Subtitle(StreamIndex|Method)|SubtitleCodecNotSupported/);
    assert.match(last().url, /TranscodeReasons=ContainerNotSupported&/);
    assert.deepEqual(r.body.value.reasons, ["container mkv"]);
    const dp = lastPlaybackInfo().DeviceProfile as { SubtitleProfiles: { Format: string; Method: string }[] };
    assert.ok(dp.SubtitleProfiles.some((p) => p.Format === "pgssub" && p.Method === "Embed"), "a PGS track doesn't stop direct play");
  });

  test("Roku: H.264 MKV direct, HEVC 4K transcoded to TS", async () => {
    assert.equal((await play("roku", "m2")).body.value.method, "direct");
    assert.match(last().url, /stream\.mkv\?/);
    assert.equal(last().mime, "video/x-matroska");
    assert.equal((await play("roku", "m1")).body.value.method, "transcode");
    assert.match(last().url, /SegmentContainer=ts/);
    assert.equal(lastPlaybackInfo().MaxStreamingBitrate, 20_000_000);
  });

  test("a per-TV cap lowers the bitrate and can turn direct play into HLS", async () => {
    await t.api("PUT", "/api/admin/tvs/roku", { capMbps: 4 });
    assert.equal((await play("roku", "m2")).body.value.method, "transcode");
    assert.equal(lastPlaybackInfo().MaxStreamingBitrate, 4_000_000);
    assert.match(last().url, /VideoBitrate=4000000/);
  });

  test("allow 4K off: the Apple TV asks for 1080p", async () => {
    await t.api("PUT", "/api/admin/tvs/atv", { allow4k: false });
    assert.equal((await play("atv", "m1")).body.value.method, "transcode");
    const dp = lastPlaybackInfo().DeviceProfile as { CodecProfiles: { Conditions: { Property: string; Value: string }[] }[] };
    assert.equal(dp.CodecProfiles[0]!.Conditions.find((c) => c.Property === "Height")!.Value, "1080");
  });

  test("the TV refuses: staff see why, nothing stays playing", async () => {
    t.tvs.playAnswer = { ok: false, reason: "busy", message: "Another app is on that TV." };
    const r = await play("atv", "m2");
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "Another app is on that TV.");
    assert.equal((await state()).tvs.find((x) => x.displayId === "atv")!.now, null);
  });

  test("now playing follows the TV; pause, ±30 s, stop; reports to the server", async () => {
    await play("atv", "m2");
    let now = (await state()).tvs.find((x) => x.displayId === "atv")!.now!;
    assert.equal(now.state, "starting");
    t.tvs.statuses.set("atv", { state: "playing", position: 120, duration: 5400 });
    await t.app.player.tick();
    now = (await state()).tvs.find((x) => x.displayId === "atv")!.now!;
    assert.deepEqual([now.state, now.positionSec, now.durationSec], ["playing", 120, 5400]);

    await t.api("POST", "/api/admin/tvs/atv/control", { action: "pause" });
    await t.api("POST", "/api/admin/tvs/atv/control", { action: "forward" });
    await t.api("POST", "/api/admin/tvs/atv/control", { action: "back" });
    assert.deepEqual(t.tvs.controls.map((c) => c.action), ["pause", { seek: 150 }, { seek: 120 }]);

    await t.api("POST", "/api/admin/tvs/atv/control", { action: "stop" });
    assert.deepEqual(t.tvs.controls.at(-1)!.action, "stop");
    assert.equal((await state()).tvs.find((x) => x.displayId === "atv")!.now, null);
    const kinds = jf.reports.map((r) => r.kind);
    assert.deepEqual([kinds[0], kinds.at(-2), kinds.at(-1)], ["/Start", "/Stopped", "/Encodings"], "a transcode is freed on stop");
    const stopped = jf.reports.find((r) => r.kind === "/Stopped")!.body;
    assert.equal(stopped.PositionTicks, 120 * 1e7, "the resume point is where it stopped");
  });

  test("a series plays from the next episode and goes on when one ends", async () => {
    await play("roku", "s1");
    assert.equal(last().title, "The Show: Episode 2", "episode 1 is watched: start at 2");
    t.tvs.statuses.set("roku", { state: "playing", position: 10 });
    await t.app.player.tick();
    t.tvs.statuses.set("roku", { state: "stopped", position: 1790 });
    await t.app.player.tick();
    assert.equal(last().title, "The Show: Episode 3");
    const done = jf.reports.filter((r) => r.kind === "/Stopped")[0]!.body;
    assert.equal(done.PositionTicks, 1800 * 1e7, "finished: reported at the end, so the server marks it watched");
    // The last one ends: the TV is free again.
    t.tvs.statuses.set("roku", { state: "playing", position: 5 });
    await t.app.player.tick();
    t.tvs.statuses.set("roku", { state: "stopped", position: 1800 });
    await t.app.player.tick();
    assert.equal((await state()).tvs.find((x) => x.displayId === "roku")!.now, null);
  });

  test("stopped part-way with the TV's own remote: let go, keep the resume point", async () => {
    await play("atv", "m2");
    t.tvs.statuses.set("atv", { state: "playing", position: 300 });
    await t.app.player.tick();
    t.tvs.statuses.set("atv", { state: "stopped", position: 300 });
    await t.app.player.tick();
    assert.equal((await state()).tvs.find((x) => x.displayId === "atv")!.now, null);
    assert.equal(t.tvs.plays.length, 1, "nothing else started");
    assert.equal(jf.reports.find((r) => r.kind === "/Stopped")!.body.PositionTicks, 300 * 1e7);
  });

  test("the TV reports an error: staff see it", async () => {
    await play("atv", "m2");
    t.tvs.statuses.set("atv", { state: "error", message: "unsupported format" });
    await t.app.player.tick();
    const now = (await state()).tvs.find((x) => x.displayId === "atv")!.now!;
    assert.equal(now.state, "error");
    assert.match(now.message ?? "", /unsupported format/);
  });

  test("Roku: no resume point (its player starts at the beginning) and no skipping", async () => {
    await play("roku", "m1");
    assert.equal(last().startAt, undefined);
    assert.equal((await state()).tvs.find((x) => x.displayId === "roku")!.canSeek, false);
    const r = await t.api<{ error: string }>("POST", "/api/admin/tvs/roku/control", { action: "forward" });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /can.t skip/);
    assert.equal(t.tvs.controls.length, 0, "nothing sent to the TV");
  });

  const addDen = (seek: boolean) =>
    t.tvs.list.push({ id: "den", name: "Den TV", kind: "venuebox", model: "Android TV 4K", online: true, formats: { containers: ["mp4", "mkv", "hls"], video: ["h264", "hevc"], audio: ["aac", "ac3", "eac3"], maxHeight: 2160, seek, ranges: ["sdr", "hdr10"] } });

  test("Venuebox app: its formats decide; a 4K HEVC MP4 and an H.264 MKV both play as they are, from the resume point", async () => {
    addDen(true);
    const r = await play("den", "m1");
    assert.equal(r.body.value.method, "direct");
    assert.match(last().url, /stream.mp4?/);
    assert.equal(last().startAt, 600);
    assert.equal(lastPlaybackInfo().MaxStreamingBitrate, 80_000_000);
    const dp = lastPlaybackInfo().DeviceProfile as { Name: string; DirectPlayProfiles: { Container: string; VideoCodec: string; AudioCodec: string }[] };
    assert.equal(dp.Name, "Venuebox app");
    assert.deepEqual(dp.DirectPlayProfiles[0], { Type: "Video", Container: "mp4,mkv", VideoCodec: "h264,hevc", AudioCodec: "aac,ac3,eac3" });
    assert.equal((await play("den", "m2")).body.value.method, "direct");
    assert.equal(last().mime, "video/x-matroska");
    const tv = (await state()).tvs.find((x) => x.displayId === "den")!;
    assert.equal(tv.canSeek, true);
    assert.equal(tv.profile, "venuebox");
    assert.equal(tv.profileLabel, "Venuebox app");
    assert.equal(tv.maxMbps, 80);
    assert.equal(tv.maxHeight, 2160);
    const c = await t.api("POST", "/api/admin/tvs/den/control", { action: "forward" });
    assert.equal(c.status, 200);
    assert.equal(typeof (t.tvs.controls.at(-1)!.action as { seek: number }).seek, "number");
  });

  test("a screen on the box (kind local): its formats decide, seek works", async () => {
    t.tvs.list.push({ id: "hdmi", name: "Back bar screen", kind: "local", model: "HDMI-1", online: true, formats: { containers: ["mp4", "mkv", "hls"], video: ["h264"], audio: ["aac", "ac3"], maxHeight: 1080, seek: true, ranges: ["sdr"] } });
    assert.equal((await play("hdmi", "m2")).body.value.method, "direct", "H.264 MKV plays as it is");
    assert.equal((await play("hdmi", "m1")).body.value.method, "transcode", "4K HDR HEVC is converted");
    assert.match(last().url, /SegmentContainer=ts/);
    assert.equal(lastPlaybackInfo().MaxStreamingBitrate, 40_000_000);
    const tv = (await state()).tvs.find((x) => x.displayId === "hdmi")!;
    assert.equal(tv.profile, "venuebox");
    assert.equal(tv.profileLabel, "Screen on the box");
    assert.equal(tv.canSeek, true);
    assert.equal(tv.maxHeight, 1080);
  });

  test("Venuebox app that can't seek: no resume point, no skipping", async () => {
    addDen(false);
    await play("den", "m1");
    assert.equal(last().startAt, undefined);
    assert.equal((await state()).tvs.find((x) => x.displayId === "den")!.canSeek, false);
    const r = await t.api<{ error: string }>("POST", "/api/admin/tvs/den/control", { action: "back" });
    assert.equal(r.status, 409);
    assert.equal(t.tvs.controls.length, 0);
  });

  test("Venuebox app with 4K off: HLS at 1080p", async () => {
    addDen(true);
    await t.api("PUT", "/api/admin/tvs/den", { allow4k: false });
    assert.equal((await play("den", "m1")).body.value.method, "transcode");
    assert.match(last().url, /SegmentContainer=mp4/, "HEVC HLS in fMP4 segments");
  });

  test("the box asks for Apple TV video pairing: staff are told how", async () => {
    t.tvs.playAnswer = { ok: false, reason: "needs-pairing" };
    const r = await play("atv", "m2");
    assert.match(r.body.error ?? "", /Pair TV control/);
  });

  test("a collection plays its movies in order", async () => {
    await play("atv", "b1");
    assert.equal(last().title, "Big Movie");
    const now = (await state()).tvs.find((x) => x.displayId === "atv")!.now!;
    assert.equal(now.upNext, "1 more from Movie Night");
  });

  test("stream links stay out of the staff page's state", async () => {
    await play("atv", "m1");
    const s = JSON.stringify(await state());
    assert.ok(!s.includes(TOKEN) && !s.includes("api_key"));
  });
});
