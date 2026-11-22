// Settings, browsing, playback choices and the player, against a fake Jellyfin and fake TVs.
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Card, ItemDetail, Library, Page, PublicState, StaffState } from "@movies/shared";
import { Vote } from "../src/vote.js";
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

  test("item tracks: audio and subtitles with labels, the default marked", async () => {
    const it = (await t.api<{ value: { tracks: { audio: { index: number; label: string; default: boolean }[]; subtitles: { index: number; label: string; external?: boolean; text?: boolean }[]; defaultAudio: number } } }>("GET", "/api/admin/items/m2")).body.value;
    assert.equal(it.tracks.defaultAudio, 1);
    assert.deepEqual(it.tracks.audio.map((a) => [a.index, a.label, a.default]), [
      [1, "Dolby Digital 5.1 - English", true],
      [2, "French - AAC - Stereo", false],
    ]);
    assert.deepEqual(it.tracks.subtitles.map((s) => [s.index, s.label, s.external ?? false, s.text]), [
      [3, "English - PGSSUB", false, false],
      [4, "Spanish - SUBRIP", true, true],
    ]);
  });

  test("another audio track: the server's HLS with that track, even where the file plays as it is", async () => {
    const r = await play("roku", "m2", { audioIndex: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.body.value.method, "transcode");
    assert.deepEqual(r.body.value.reasons, ["another audio track"]);
    assert.match(last().url, /AudioStreamIndex=2/);
    assert.doesNotMatch(last().url, /SubtitleStreamIndex/, "no subtitle burned in");
    const q = jf.requests.filter((x) => x.path.includes("/PlaybackInfo")).at(-1)!;
    assert.equal(q.body!.MediaSourceId, "m2");
    assert.equal(q.body!.EnableDirectPlay, false);
    const now = (await state()).tvs.find((x) => x.displayId === "roku")!.now!;
    assert.equal(now.audioIndex, 2);
    assert.equal(now.subtitleIndex, null);
    assert.equal(now.tracks!.audio.length, 2);
  });

  test("the default audio track picked: still plays as it is", async () => {
    const r = await play("roku", "m2", { audioIndex: 1, subtitleIndex: null });
    assert.equal(r.body.value.method, "direct");
  });

  test("subtitles: burned in, the server told which", async () => {
    const r = await play("atv", "m2", { subtitleIndex: 4 });
    assert.equal(r.body.value.method, "transcode");
    assert.ok(r.body.value.reasons.includes("subtitles burned in"));
    assert.match(last().url, /SubtitleStreamIndex=4&SubtitleMethod=Encode/);
    assert.equal((await state()).tvs.find((x) => x.displayId === "atv")!.now!.subtitleIndex, 4);
  });

  test("a track that isn't in the file is ignored (plays the defaults)", async () => {
    const r = await play("roku", "m2", { audioIndex: 9, subtitleIndex: 9 });
    assert.equal(r.body.value.method, "direct");
    assert.equal((await t.api("POST", "/api/admin/play", { displayId: "roku", itemId: "m2", audioIndex: "x", subtitleIndex: -3 })).status, 200, "bad values are dropped");
  });

  test("changing tracks while playing: the stream starts again at the same spot", async () => {
    await play("atv", "m2");
    t.tvs.statuses.set("atv", { state: "playing", position: 1234 });
    await t.app.player.tick();
    const plays = t.tvs.plays.length;
    const events: string[] = [];
    t.bg.emit = ((e: { type: string }) => void events.push(e.type)) as unknown as typeof t.bg.emit;
    const r = await t.api<{ value: { audioIndex: number; subtitleIndex: number | null } }>("POST", "/api/admin/tvs/atv/tracks", { audioIndex: 2, subtitleIndex: 3 });
    assert.equal(r.status, 200);
    assert.equal(t.tvs.plays.length, plays + 1);
    assert.equal(last().startAt, 1231, "a few seconds back from where it was");
    assert.match(last().url, /AudioStreamIndex=2/);
    assert.match(last().url, /SubtitleStreamIndex=3/);
    assert.equal(r.body.value.audioIndex, 2);
    assert.equal(r.body.value.subtitleIndex, 3);
    assert.deepEqual(events, [], "no video_started/stopped for a track change");
    assert.equal(jf.reports.find((x) => x.kind === "/Stopped")?.body.PositionTicks, 1234 * 1e7, "the old stream is reported stopped where it was");
    // And back to the defaults: the file as it is again.
    await t.api("POST", "/api/admin/tvs/atv/tracks", { audioIndex: 1, subtitleIndex: null });
    assert.doesNotMatch(last().url, /SubtitleStreamIndex/);
  });

  test("the status poll during a switch doesn't lose the TV", async () => {
    await play("atv", "m2");
    t.tvs.statuses.set("atv", { state: "playing", position: 500 });
    await t.app.player.tick();
    jf.playbackDelayMs = 150;
    const switching = t.api("POST", "/api/admin/tvs/atv/tracks", { subtitleIndex: 3 });
    await new Promise((r) => setTimeout(r, 60));
    await t.app.player.tick();
    assert.equal((await t.api("POST", "/api/admin/tvs/atv/tracks", { subtitleIndex: 4 })).status, 409, "a second switch waits");
    assert.equal((await switching).status, 200);
    jf.playbackDelayMs = 0;
    const now = (await state()).tvs.find((x) => x.displayId === "atv")!.now;
    assert.equal(now?.subtitleIndex, 3, "still tracked after the switch");
  });

  test("changing tracks on a Roku starts over; bad tracks are refused", async () => {
    await play("roku", "m2");
    t.tvs.statuses.set("roku", { state: "playing", position: 900 });
    await t.app.player.tick();
    await t.api("POST", "/api/admin/tvs/roku/tracks", { audioIndex: 2 });
    assert.equal(last().startAt, undefined);
    assert.equal((await t.api("POST", "/api/admin/tvs/roku/tracks", { audioIndex: 7 })).status, 400);
    assert.equal((await t.api("POST", "/api/admin/tvs/atv/tracks", { audioIndex: 2 })).status, 409, "nothing playing there");
  });

  test("a series keeps the chosen languages: French audio and subtitles on the next episode", async () => {
    // e1 is watched, so the series starts at e2; e3 has its French tracks at other indexes.
    const r = await play("atv", "s1", { audioIndex: 2, subtitleIndex: 3 });
    assert.equal(r.status, 200);
    assert.match(last().url, /\/videos\/e2\/.*AudioStreamIndex=2.*SubtitleStreamIndex=3/);
    t.tvs.statuses.set("atv", { state: "playing", position: 1790, duration: 1800 });
    await t.app.player.tick();
    t.tvs.statuses.set("atv", { state: "stopped" });
    await t.app.player.tick();
    assert.match(last().url, /\/videos\/e3\/.*AudioStreamIndex=5.*SubtitleStreamIndex=6/, "same languages, e3's own indexes");
  });

  // ---- players that switch tracks themselves (SDK 0.19.0)
  const addNative = (containers = ["mp4", "mkv", "hls"]) =>
    t.tvs.list.push({ id: "den", name: "Den TV", kind: "venuebox", model: "Android TV", online: true, formats: { containers, video: ["h264", "hevc"], audio: ["aac", "ac3", "eac3"], maxHeight: 2160, seek: true, ranges: ["sdr", "hdr10"], tracks: true } });

  test("native player: the file as it is with every track listed, the choice on at the start", async () => {
    addNative();
    const r = await play("den", "m2", { audioIndex: 2, subtitleIndex: 3 });
    assert.equal(r.body.value.method, "direct", "no repackaging, no burning in");
    assert.deepEqual(r.body.value.reasons, []);
    const tr = last().tracks!;
    assert.deepEqual(tr.audio!.map((a) => [a.id, a.index, a.default ?? false, a.label]), [
      ["a1", 0, true, "Dolby Digital 5.1 - English"],
      ["a2", 1, false, "French - AAC - Stereo"],
    ]);
    assert.deepEqual(tr.subtitles!.map((s) => [s.id, s.index ?? null, !!s.url, s.format ?? null]), [
      ["s3", 0, false, null],
      ["s4", null, true, "vtt"],
    ], "the PGS inside the file by its place; the separate SRT as a WebVTT side file");
    assert.match(tr.subtitles![1]!.url!, /\/jellyfin\/Videos\/m2\/m2\/Subtitles\/4\/0\/Stream\.vtt\?api_key=/);
    assert.equal(tr.audioId, "a2");
    assert.equal(tr.subtitleId, "s3");
    const now = (await state()).tvs.find((x) => x.displayId === "den")!.now!;
    assert.equal(now.audioIndex, 2);
    assert.equal(now.subtitleIndex, 3);
  });

  test("native player: switching happens on the TV, with no new stream", async () => {
    addNative();
    await play("den", "m2");
    const plays = t.tvs.plays.length;
    const r = await t.api<{ value: { audioIndex: number; subtitleIndex: number | null }; inPlace: boolean }>("POST", "/api/admin/tvs/den/tracks", { audioIndex: 2, subtitleIndex: 4 });
    assert.equal(r.status, 200);
    assert.equal(r.body.inPlace, true);
    assert.equal(t.tvs.plays.length, plays, "no new stream");
    assert.deepEqual(t.tvs.controls.map((c) => c.action), [{ audio: "a2" }, { subtitle: "s4" }]);
    assert.equal(r.body.value.audioIndex, 2);
    assert.equal(r.body.value.subtitleIndex, 4);
    // Off again: still on the TV.
    await t.api("POST", "/api/admin/tvs/den/tracks", { audioIndex: 2, subtitleIndex: null });
    assert.deepEqual(t.tvs.controls.at(-1)!.action, { subtitle: null });
    assert.equal(t.tvs.plays.length, plays);
  });

  test("native player on a converted stream: text subtitles as a side file, picture ones burned in", async () => {
    addNative(["mp4", "hls"]); // can't open an MKV: the server converts it
    let r = await play("den", "m2", { subtitleIndex: 4 });
    assert.equal(r.body.value.method, "transcode");
    assert.doesNotMatch(last().url, /SubtitleStreamIndex/, "the SRT isn't burned in");
    assert.ok(last().tracks!.subtitles!.find((s) => s.id === "s4")!.url);
    assert.equal(last().tracks!.subtitleId, "s4");
    assert.equal(last().tracks!.audio!.find((a) => a.id === "a1")!.index, 0, "the one audio track in the stream");
    assert.equal(last().tracks!.audio!.find((a) => a.id === "a2")!.index, undefined);
    r = await play("den", "m2", { subtitleIndex: 3 });
    assert.match(last().url, /SubtitleStreamIndex=3/, "the PGS is burned in");
    assert.ok(r.body.value.reasons.includes("subtitles burned in"));
    // From the burned-in PGS to the SRT: only a new stream takes the PGS away.
    const plays = t.tvs.plays.length;
    const sw = await t.api<{ inPlace: boolean }>("POST", "/api/admin/tvs/den/tracks", { subtitleIndex: 4 });
    assert.equal(sw.body.inPlace, false);
    assert.equal(t.tvs.plays.length, plays + 1);
    assert.doesNotMatch(last().url, /SubtitleStreamIndex/);
    // Audio not in the converted stream: the player can't, so a new stream with it.
    const a = await t.api<{ inPlace: boolean }>("POST", "/api/admin/tvs/den/tracks", { audioIndex: 2, subtitleIndex: 4 });
    assert.equal(a.body.inPlace, false);
    assert.match(last().url, /AudioStreamIndex=2/);
  });

  test("native player: a change made on the TV is followed, and kept for the next episode", async () => {
    addNative();
    await play("den", "s1"); // e2
    t.tvs.statuses.set("den", { state: "playing", position: 60, audio: "a1", subtitle: null });
    await t.app.player.tick();
    t.tvs.statuses.set("den", { state: "playing", position: 62, audio: "a2", subtitle: "s3" });
    await t.app.player.tick();
    const now = (await state()).tvs.find((x) => x.displayId === "den")!.now!;
    assert.equal(now.audioIndex, 2);
    assert.equal(now.subtitleIndex, 3);
    // e2 ends: e3 starts with French audio and French subtitles, by e3's own indexes.
    t.tvs.statuses.set("den", { state: "playing", position: 1790, duration: 1800 });
    await t.app.player.tick();
    t.tvs.statuses.set("den", { state: "stopped" });
    await t.app.player.tick();
    assert.match(last().url, /\/Videos\/e3\/stream/);
    assert.equal(last().tracks!.audioId, "a5");
    assert.equal(last().tracks!.subtitleId, "s6");
  });

  test("the TV's remote: next and previous through a series", async () => {
    addNative();
    await play("den", "s1"); // e2
    t.tvs.statuses.set("den", { state: "playing", position: 100, remote: ["next"] });
    await t.app.player.tick();
    assert.match(last().url, /\/Videos\/e3\/stream/);
    assert.equal(last().startAt, undefined, "from the beginning");
    t.tvs.statuses.set("den", { state: "playing", position: 3, remote: ["previous"] });
    await t.app.player.tick();
    assert.match(last().url, /\/Videos\/e2\/stream/, "near the start: the one before");
    t.tvs.statuses.set("den", { state: "playing", position: 300, remote: ["previous"] });
    await t.app.player.tick();
    assert.match(last().url, /\/Videos\/e2\/stream/, "part-way in: this one from the start");
    const plays = t.tvs.plays.length;
    t.tvs.statuses.set("den", { state: "playing", position: 5, remote: ["previous"] });
    await t.app.player.tick();
    t.tvs.statuses.set("den", { state: "playing", position: 5 });
    // e2 is the first in this queue: "previous" plays it from the start again, nothing before it.
    assert.equal(t.tvs.plays.length, plays + 1);
  });

  test("the TV's remote: a track the player couldn't switch to starts a new stream with it", async () => {
    addNative(["mp4", "hls"]);
    await play("den", "m2");
    const plays = t.tvs.plays.length;
    t.tvs.statuses.set("den", { state: "playing", position: 400, audio: "a1", subtitle: null, remote: [{ audio: "a2" }] });
    await t.app.player.tick();
    assert.equal(t.tvs.plays.length, plays + 1);
    assert.match(last().url, /AudioStreamIndex=2/);
    assert.equal(last().startAt, 397);
    assert.equal((await state()).tvs.find((x) => x.displayId === "den")!.now!.audioIndex, 2);
  });

  test("stream links and subtitle side files stay out of the log", async () => {
    addNative(["mp4", "hls"]);
    await play("den", "m2", { subtitleIndex: 4 });
    assert.ok(!t.logs.some((l) => l.includes(TOKEN) || /Stream\.vtt/.test(l)));
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

describe("guest page and vote", () => {
  beforeEach(() => connect(t, jf));

  const V1 = "voter-aaaaaaaaaaaaaaaa";
  const V2 = "voter-bbbbbbbbbbbbbbbb";
  const pub = async (voter?: string) => (await (await fetch(`${t.url}/api/public/state${voter ? `?voter=${voter}` : ""}`)).json()) as PublicState;
  const castVote = (voter: string, itemId: string) => fetch(`${t.url}/api/public/vote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voter, itemId }) });
  const add = (itemId: string) => t.api("POST", "/api/admin/vote/options", { itemId });
  const lastPlay = () => t.tvs.plays.at(-1)!;

  test("carry on watching lists part-watched movies", async () => {
    const r = await t.api<{ value: { id: string }[] }>("GET", "/api/admin/resume");
    assert.deepEqual(r.body.value.map((c) => c.id), ["m1"]);
  });

  test("the guest page needs no sign-in and shows only titles and progress", async () => {
    await t.api("POST", "/api/admin/play", { displayId: "atv", itemId: "m2" });
    t.tvs.statuses.set("atv", { state: "playing", position: 2700, duration: 5400 });
    await t.app.player.tick();
    const s = await pub();
    assert.equal(s.playing.length, 1);
    assert.equal(s.playing[0]!.tv, "Bar Apple TV");
    assert.equal(s.playing[0]!.title, "Plain Movie");
    assert.equal(s.playing[0]!.progress, 0.5);
    assert.equal(s.playing[0]!.endsInSec, 2700);
    assert.equal(s.vote, null, "no vote yet");
    const text = JSON.stringify(s);
    assert.ok(!text.includes(TOKEN) && !text.includes("api_key") && !text.includes("127.0.0.1"), "no link, key or server address");
    assert.equal((await fetch(`${t.url}/api/admin/vote/open`, { method: "POST" })).status, 401, "staff routes stay closed");
  });

  test("a vote: staff choose, guests vote once each, the winner plays when the TV is free", async () => {
    const early = await t.api<{ error: string }>("POST", "/api/admin/vote/open", { displayId: "atv", closes: "manual" });
    assert.equal(early.status, 400, "needs two movies");
    assert.match(early.body.error, /at least two movies/, "staff are told why");
    await add("m1");
    await add("m2");
    assert.equal((await add("s1")).status, 400, "a series can't go in");
    assert.equal((await pub()).vote, null, "guests see nothing until it opens");
    const open = await t.api<{ value: { open: boolean } }>("POST", "/api/admin/vote/open", { displayId: "atv", closes: "manual", autoPlay: true });
    assert.equal(open.body.value.open, true);
    assert.equal((await add("e1")).status, 409, "no changes while open");

    assert.equal((await castVote(V1, "m1")).status, 200);
    assert.equal((await castVote(V2, "m2")).status, 200);
    assert.equal((await castVote(V1, "m2")).status, 200, "changing a vote");
    assert.equal((await castVote(V1, "nope")).status, 400);
    assert.equal((await castVote("short", "m1")).status, 400);
    const s = await pub(V1);
    assert.equal(s.vote!.total, 2);
    assert.equal(s.vote!.yourVote, "m2");
    assert.deepEqual(s.vote!.options.map((o) => [o.itemId, o.votes]), [["m1", 0], ["m2", 2]]);
    assert.equal(s.vote!.tvName, "Bar Apple TV");

    const plays = t.tvs.plays.length;
    await t.api("POST", "/api/admin/vote/close");
    assert.equal(t.tvs.plays.length, plays + 1, "the TV was free: the winner starts");
    assert.equal(lastPlay().displayId, "atv");
    assert.match(lastPlay().args.url, /\/m2\//);
    assert.equal((await castVote(V2, "m1")).status, 409, "closed");
    assert.equal((await state()).vote.options.length, 0);
  });

  test("in the venue everyone shares one address: no cap on people, only on a burst", () => {
    let now = 1_000_000;
    const v = new Vote({ now: () => now, tvName: () => "TV", isPlaying: () => false, play: async () => undefined });
    v.addManual("A");
    v.addManual("B");
    v.start({ closes: "manual", autoPlay: false });
    const a = v.staffView().options[0]!.itemId;
    const id = (i: number) => `voter-${String(i).padStart(16, "0")}`;
    for (let i = 0; i < 30; i++) v.cast(id(i), a, "203.0.113.5", true);
    assert.throws(() => v.cast(id(30), a, "203.0.113.5", true), /Try again in a minute/);
    v.cast(id(3), a, "203.0.113.5", true); // someone who already voted can still change it
    now += 61_000;
    for (let i = 30; i < 50; i++) v.cast(id(i), a, "203.0.113.5", true);
    assert.equal(v.staffView().total, 50);
    // From outside the venue the cap per address stays.
    for (let i = 100; i < 106; i++) v.cast(id(i), a, "198.51.100.9", false);
    assert.throws(() => v.cast(id(106), a, "198.51.100.9", false), /Too many votes/);
  });

  test("one connection from outside the venue can't flood the vote", async () => {
    await add("m1");
    await add("m2");
    await t.api("POST", "/api/admin/vote/open", { displayId: "atv", closes: "manual" });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await castVote(`voter-${String(i).padStart(16, "0")}`, "m1")).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429, 429]);
  });

  test("closes when the movie ends: the winner follows it", async () => {
    await t.api("POST", "/api/admin/play", { displayId: "atv", itemId: "m2" });
    await add("m1");
    await add("e1");
    await t.api("POST", "/api/admin/vote/open", { displayId: "atv", closes: "movie-end", autoPlay: true });
    await castVote(V1, "m1");
    t.tvs.statuses.set("atv", { state: "playing", position: 5390, duration: 5400 });
    await t.app.player.tick();
    assert.equal((await pub()).vote!.open, true);
    t.tvs.statuses.set("atv", { state: "stopped" });
    await t.app.player.tick();
    assert.match(lastPlay().args.url, /\/m1\//, "the winner started after the movie");
    assert.equal(lastPlay().args.startAt, undefined, "from the beginning");
  });

  test("closed while a movie is still on: the winner waits; staff can start it; without auto-play it always waits", async () => {
    await t.api("POST", "/api/admin/play", { displayId: "atv", itemId: "m2" });
    t.tvs.statuses.set("atv", { state: "playing", position: 100, duration: 5400 });
    await t.app.player.tick();
    await add("m1");
    await add("e1");
    await t.api("POST", "/api/admin/vote/open", { displayId: "atv", closes: "manual", autoPlay: false });
    await castVote(V1, "e1");
    const plays = t.tvs.plays.length;
    await t.api("POST", "/api/admin/vote/close");
    assert.equal(t.tvs.plays.length, plays, "nothing interrupted");
    const st = await state();
    assert.equal(st.vote.winner!.title, "Episode 1");
    assert.equal((await pub()).vote!.winner!.title, "Episode 1");
    await t.api("POST", "/api/admin/vote/play");
    assert.match(lastPlay().args.url, /\/e1\//);
    assert.equal((await state()).vote.winner, undefined);
  });

  test("by default the winner waits: staff review the result, then play it", async () => {
    await add("m1");
    await add("m2");
    await t.api("POST", "/api/admin/vote/open", { displayId: "atv", closes: "manual" });
    await castVote(V1, "m2");
    await castVote(V2, "m2");
    const plays = t.tvs.plays.length;
    await t.api("POST", "/api/admin/vote/close");
    assert.equal(t.tvs.plays.length, plays, "the TV is free, but nothing starts by itself");
    const st = await state();
    assert.equal(st.vote.autoPlay, false);
    assert.equal(st.vote.winner!.title, "Plain Movie");
    assert.equal(st.vote.winnerTvName, "Bar Apple TV");
    assert.deepEqual(st.vote.results, [{ title: "Plain Movie", votes: 2 }, { title: "Big Movie", votes: 0 }]);
    // Even when a movie ends on that TV, it still waits.
    await t.app.player.tick();
    assert.equal(t.tvs.plays.length, plays);
    await t.api("POST", "/api/admin/vote/play");
    assert.equal(t.tvs.plays.length, plays + 1);
    assert.equal((await state()).vote.results, undefined);
  });

  test("a timed vote closes by itself; nobody voted: nothing plays", async () => {
    await add("m1");
    await add("m2");
    await t.api("POST", "/api/admin/vote/open", { displayId: "atv", closes: "time", minutes: 1 });
    assert.ok((await pub()).vote!.closesInSec! <= 60);
    const plays = t.tvs.plays.length;
    await t.api("POST", "/api/admin/vote/close");
    assert.equal(t.tvs.plays.length, plays);
    assert.match((await state()).vote.note ?? "", /Nobody voted/);
    await t.api("DELETE", "/api/admin/vote");
    assert.equal((await state()).vote.note, undefined);
  });
});

describe("without a media server", () => {
  const pub = async () => (await (await fetch(`${t.url}/api/public/state`)).json()) as PublicState;

  test("tonight's list: typed by staff, shown to guests", async () => {
    await t.api("POST", "/api/admin/login", {});
    const a = await t.api<{ value: { id: string; title: string }[] }>("POST", "/api/admin/tonight", { title: "  The Late Show  ", when: "9:00 pm, Patio TV" });
    assert.equal(a.status, 200);
    assert.equal(a.body.value[0]!.title, "The Late Show");
    await t.api("POST", "/api/admin/tonight", { title: "Second Feature" });
    assert.equal((await t.api("POST", "/api/admin/tonight", { title: "   " })).status, 400);
    const id = a.body.value[0]!.id;
    await t.api("PUT", `/api/admin/tonight/${id}`, { onNow: true });
    const s = await pub();
    assert.deepEqual(s.tonight.map((e) => [e.title, e.when ?? null, e.onNow]), [
      ["The Late Show", "9:00 pm, Patio TV", true],
      ["Second Feature", null, false],
    ]);
    assert.deepEqual(s.playing, []);
    await t.api("DELETE", `/api/admin/tonight/${id}`);
    assert.equal((await pub()).tonight.length, 1);
    assert.equal((await fetch(`${t.url}/api/admin/tonight`, { method: "POST" })).status, 401);
  });

  test("a vote on typed-in movies, with no TV: the winner is announced for staff to put on", async () => {
    assert.equal((await state()).ready, false);
    await t.api("POST", "/api/admin/vote/options", { title: "Typed Movie A" });
    await t.api("POST", "/api/admin/vote/options", { title: "Typed Movie B" });
    await t.api("POST", "/api/admin/vote/options", { title: "typed movie b" });
    const st = await state();
    assert.deepEqual(st.vote.options.map((o) => [o.title, o.manual]), [["Typed Movie A", true], ["Typed Movie B", true]]);
    assert.equal((await t.api("POST", "/api/admin/vote/open", { closes: "movie-end" })).status, 400, "movie-end needs a TV");
    assert.equal((await t.api("POST", "/api/admin/vote/open", { closes: "manual" })).status, 200);
    const b = (await pub()).vote!.options[1]!.itemId;
    assert.equal((await fetch(`${t.url}/api/public/vote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voter: "voter-cccccccccccccccc", itemId: b }) })).status, 200);
    await t.api("POST", "/api/admin/vote/close");
    assert.equal(t.tvs.plays.length, 0, "nothing can start by itself");
    const after = await state();
    assert.equal(after.vote.winner!.title, "Typed Movie B");
    assert.equal(after.vote.winner!.manual, true);
    assert.match(after.vote.note ?? "", /put it on yourself/);
    assert.equal((await pub()).vote!.winner!.title, "Typed Movie B");
    assert.equal((await t.api("POST", "/api/admin/vote/play")).status, 409);
  });
});
