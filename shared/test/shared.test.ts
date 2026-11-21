import { test } from "node:test";
import assert from "node:assert/strict";
import { canDirectPlay, chooseBitrate, effectiveProfile, normaliseServerUrl, profileFor, redact, serverPath, TV_PROFILES } from "../src/index.js";

// ------------------------------------------------------------------ server address

const ok = (input: string) => {
  const r = normaliseServerUrl(input);
  assert.ok(r.ok, `expected ${input} to parse: ${!r.ok ? r.error : ""}`);
  return r;
};

test("url: http and https, any port, kept as typed", () => {
  assert.equal(ok("http://media.example.org:8096").url, "http://media.example.org:8096");
  assert.equal(ok("https://media.example.org:8920").url, "https://media.example.org:8920");
  assert.equal(ok("https://media.example.org:8443").url, "https://media.example.org:8443");
  assert.equal(ok("http://10.0.0.5:32400").url, "http://10.0.0.5:32400");
  assert.equal(ok("http://[2001:db8::1]:8096").url, "http://[2001:db8::1]:8096");
});

test("url: insecure is http only", () => {
  assert.equal(ok("http://a.example:8096").insecure, true);
  assert.equal(ok("https://a.example:8920").insecure, false);
});

test("url: base path kept, trailing slashes dropped", () => {
  assert.equal(ok("https://media.example.org:8443/jellyfin").url, "https://media.example.org:8443/jellyfin");
  assert.equal(ok("https://media.example.org:8443/jellyfin///").url, "https://media.example.org:8443/jellyfin");
  assert.equal(ok("https://media.example.org/").url, "https://media.example.org");
  assert.equal(ok("https://Media.Example.ORG/Jellyfin").url, "https://media.example.org/Jellyfin");
});

test("url: no scheme assumes http and says so", () => {
  const r = ok("media.example.org:8096");
  assert.equal(r.url, "http://media.example.org:8096");
  assert.equal(r.insecure, true);
  assert.match(r.notes.join(" "), /assumes http:\/\//);
  assert.equal(ok("  media.example.org  ").url, "http://media.example.org");
});

test("url: default ports drop, other ports stay", () => {
  assert.equal(ok("http://a.example:80").url, "http://a.example");
  assert.equal(ok("https://a.example:443/x").url, "https://a.example/x");
  assert.equal(ok("https://a.example:8096").url, "https://a.example:8096");
});

test("url: pasted from the web app, /web and the hash are dropped", () => {
  const r = ok("https://a.example:8920/web/#/home.html");
  assert.equal(r.url, "https://a.example:8920");
  assert.ok(r.notes.length >= 2);
  assert.equal(ok("https://a.example/jf/web/index.html").url, "https://a.example/jf");
});

test("url: refusals", () => {
  for (const bad of ["", "   ", "ftp://a.example", "http://", "http://user:pw@a.example", "a b.example"]) {
    const r = normaliseServerUrl(bad);
    assert.equal(r.ok, false, bad);
  }
});

test("serverPath keeps the base path", () => {
  assert.equal(serverPath("https://a.example/jellyfin", "/Items/1"), "https://a.example/jellyfin/Items/1");
  assert.equal(serverPath("https://a.example:8920", "System/Info/Public"), "https://a.example:8920/System/Info/Public");
});

// ------------------------------------------------------------------ profiles

test("profileFor: from what the box says", () => {
  assert.equal(profileFor({ kind: "appletv", model: "AppleTV4KGen3" }), "appletv4k");
  assert.equal(profileFor({ kind: "roku", model: "3930X" }), "roku3930");
  assert.equal(profileFor({ kind: "roku", model: "3800X" }), "roku3800");
  assert.equal(profileFor({ kind: "roku", model: "4800X" }), "roku3930");
  assert.equal(profileFor({ kind: "chromecast" }), "unknown");
  assert.equal(profileFor(undefined), "unknown");
});

const hevc4kHdr = { container: "mp4", video: { codec: "hevc", width: 3840, height: 2160, range: "HDR10" }, audio: { codec: "eac3", channels: 6 }, bitrate: 40_000_000 };
const h264mkv = { container: "mkv", video: { codec: "h264", width: 1920, height: 1080, range: "SDR" }, audio: { codec: "ac3", channels: 6 }, bitrate: 8_000_000 };

test("direct play: Apple TV plays 4K HDR MP4 as it is", () => {
  assert.deepEqual(canDirectPlay(effectiveProfile("appletv4k"), hevc4kHdr), { ok: true });
  assert.deepEqual(canDirectPlay(effectiveProfile("appletv4k"), { ...hevc4kHdr, video: { ...hevc4kHdr.video, range: "DOVIWithHDR10" } }), { ok: true });
  // Jellyfin's container list for an MP4.
  assert.deepEqual(canDirectPlay(effectiveProfile("appletv4k"), { ...hevc4kHdr, container: "mov,mp4,m4a,3gp,3g2,mj2" }), { ok: true });
});

test("direct play: Apple TV gets HLS for an MKV", () => {
  const r = canDirectPlay(effectiveProfile("appletv4k"), h264mkv);
  assert.equal(r.ok, false);
  assert.match((r as { reasons: string[] }).reasons.join(), /container mkv/);
});

test("direct play: Roku Express plays H.264 MKV with AC3; not HEVC, 4K, HDR or EAC3", () => {
  assert.deepEqual(canDirectPlay(effectiveProfile("roku3930"), h264mkv), { ok: true });
  const r = canDirectPlay(effectiveProfile("roku3930"), hevc4kHdr);
  assert.equal(r.ok, false);
  const why = (r as { reasons: string[] }).reasons.join(" | ");
  for (const w of ["video hevc", "2160p", "HDR10", "audio eac3"]) assert.match(why, new RegExp(w));
});

test("direct play: Roku Stick plays HEVC 1080p SDR", () => {
  const f = { container: "mkv", video: { codec: "hevc", width: 1920, height: 1080, range: "SDR" }, audio: { codec: "aac", channels: 2 }, bitrate: 5_000_000 };
  assert.deepEqual(canDirectPlay(effectiveProfile("roku3800"), f), { ok: true });
  assert.equal(canDirectPlay(effectiveProfile("roku3930"), f).ok, false);
});

test("direct play: the unknown profile always transcodes to HLS", () => {
  const f = { container: "mp4", video: { codec: "h264", width: 1280, height: 720 }, audio: { codec: "aac", channels: 2 }, bitrate: 2_000_000 };
  assert.equal(canDirectPlay(effectiveProfile("unknown"), f).ok, false);
  assert.deepEqual(TV_PROFILES.unknown.hls, { segment: "ts", videoCodecs: ["h264"] });
});

test("bitrate: profile maximum, lowered by a per-TV cap, never raised", () => {
  assert.equal(chooseBitrate(TV_PROFILES.appletv4k, null), 80_000_000);
  assert.equal(chooseBitrate(TV_PROFILES.appletv4k, 25), 25_000_000);
  assert.equal(chooseBitrate(TV_PROFILES.roku3930, 50), 20_000_000);
  assert.equal(chooseBitrate(TV_PROFILES.roku3930, 0), 20_000_000);
  assert.equal(chooseBitrate(TV_PROFILES.roku3930, Number.NaN), 20_000_000);
  assert.equal(effectiveProfile("appletv4k", { capMbps: 15 }).maxBitrate, 15_000_000);
});

test("bitrate cap turns a direct play into a transcode", () => {
  const r = canDirectPlay(effectiveProfile("appletv4k", { capMbps: 20 }), hevc4kHdr);
  assert.equal(r.ok, false);
  assert.match((r as { reasons: string[] }).reasons.join(), /40 Mbit\/s is above the 20 Mbit\/s cap/);
});

test("allow 4K off: an Apple TV is held to 1080p", () => {
  const p = effectiveProfile("appletv4k", { allow4k: false });
  assert.equal(p.maxHeight, 1080);
  assert.equal(canDirectPlay(p, hevc4kHdr).ok, false);
  assert.equal(effectiveProfile("appletv4k", { allow4k: true }).maxHeight, 2160);
});

// ------------------------------------------------------------------ redaction

test("redact: query keys and tokens", () => {
  const url = "https://m.example/videos/abc/master.m3u8?DeviceId=d1&MediaSourceId=abc&api_key=SECRET1&ApiKey=SECRET2&X-Plex-Token=SECRET3&X-Emby-Token=SECRET4&x=1";
  const out = redact(url);
  for (const s of ["SECRET1", "SECRET2", "SECRET3", "SECRET4"]) assert.ok(!out.includes(s), out);
  assert.match(out, /MediaSourceId=abc/);
  assert.match(out, /&x=1$/);
});

test("redact: Authorization headers in every shape", () => {
  const lines = [
    `authorization: MediaBrowser Client="Movies", Device="Box", DeviceId="d", Version="0.1.0", Token="SECRET5"`,
    `headers={"Authorization":"MediaBrowser Client=\\"Movies\\", Token=\\"SECRET6\\""}`,
    `X-Emby-Token: SECRET7`,
    `x-plex-token=SECRET8`,
    `Authorization: Bearer SECRET9`,
    `{"AccessToken":"SECRET10","User":{"Name":"movies"}}`,
    `{"Username":"movies","Pw":"SECRET11"}`,
  ];
  for (const l of lines) {
    const out = redact(l);
    assert.ok(!/SECRET\d+/.test(out), `${l} → ${out}`);
    assert.match(out, /\[redacted\]/);
  }
  assert.match(redact(`{"AccessToken":"S","User":{"Name":"movies"}}`), /"Name":"movies"/);
});

test("redact: leaves ordinary text alone", () => {
  const s = "played Movie X on TV 3 method=direct position=120";
  assert.equal(redact(s), s);
});
