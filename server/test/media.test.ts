// The box's side: media_list / media_play / media_stop, status.media.targets and events,
// against a fake box core, plus the box video adapter (bg.playVideo, planned for the SDK).
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createBoxVideo } from "../src/video.js";
import { makeBarGames } from "../src/bargames.js";
import { connect, CORE_TOKEN, fakeCore, fakeJellyfin, TOKEN, startApp, type FakeCore, type FakeJellyfin, type TestApp } from "./fakes.js";

let jf: FakeJellyfin;
let core: FakeCore;
let t: TestApp;

async function command<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(t.url + "/__bargames/command", { method: "POST", headers: { authorization: `Bearer ${CORE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ command: name, args }) });
  return (await r.json()) as T;
}
async function targets() {
  const r = await fetch(t.url + "/__bargames/status", { headers: { authorization: `Bearer ${CORE_TOKEN}` } });
  return ((await r.json()) as { media?: { targets: { displayId: string; state: string; itemId?: string; nowPlaying?: { title: string; listName?: string } }[] } }).media?.targets ?? [];
}
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeEach(async () => {
  jf = await fakeJellyfin();
  core = await fakeCore();
  t = await startApp({ core });
  await t.app.player.tvs(true);
});
afterEach(async () => {
  await t.close();
  await core.close();
  await jf.close();
});

describe("box commands", () => {
  test("not set up: media_list is empty, media_play says what to do", async () => {
    assert.deepEqual((await command<{ data: { items: unknown[] } }>("media_list")).data.items, []);
    const r = await command<{ ok: boolean; message: string }>("media_play", { displayId: "atv", itemId: "m1" });
    assert.equal(r.ok, false);
    assert.match(r.message, /settings/);
  });

  test("media_list: each library (shuffle) and collection", async () => {
    await connect(t, jf);
    const r = await command<{ ok: boolean; data: { items: { id: string; name: string; kind: string }[] } }>("media_list");
    assert.deepEqual(
      r.data.items.map((i) => [i.id, i.name, i.kind]),
      [
        ["lib-movies", "Movies (shuffle)", "list"],
        ["lib-shows", "Shows (shuffle)", "list"],
        ["b1", "Movie Night", "list"],
      ],
    );
  });

  test("media_play a movie, a collection or a library; status follows; events have no links", async () => {
    await connect(t, jf);
    let r = await command<{ ok: boolean }>("media_play", { displayId: "atv", itemId: "m2" });
    assert.equal(r.ok, true);
    let tg = (await targets()).find((x) => x.displayId === "atv")!;
    assert.deepEqual([tg.state, tg.nowPlaying?.title, tg.itemId], ["starting", "Plain Movie", "m2"]);
    t.tvs.statuses.set("atv", { state: "paused", position: 50 });
    await t.app.player.tick();
    tg = (await targets()).find((x) => x.displayId === "atv")!;
    assert.equal(tg.state, "paused");
    assert.equal((await targets()).find((x) => x.displayId === "roku")!.state, "linked");

    r = await command<{ ok: boolean }>("media_play", { displayId: "roku", itemId: "b1" });
    assert.equal(r.ok, true);
    tg = (await targets()).find((x) => x.displayId === "roku")!;
    assert.deepEqual([tg.itemId, tg.nowPlaying?.listName], ["b1", "1 more from Movie Night"]);

    r = await command<{ ok: boolean }>("media_play", { displayId: "roku", itemId: "lib-movies" });
    assert.equal(r.ok, true);
    assert.equal(t.tvs.plays.length, 3);

    const stop = await command<{ ok: boolean }>("media_stop", { displayId: "atv" });
    assert.equal(stop.ok, true);
    assert.equal((await targets()).find((x) => x.displayId === "atv")!.state, "linked");

    await until(() => core.events.filter((e) => e.type === "video_stopped").length >= 1);
    const started = core.events.filter((e) => e.type === "video_started");
    assert.deepEqual(started[0]!.data, { tv: "Bar Apple TV", title: "Plain Movie" });
    assert.deepEqual(core.events.find((e) => e.type === "video_stopped")!.data, { tv: "Bar Apple TV" });
    const all = JSON.stringify(core.events);
    assert.ok(!all.includes(TOKEN) && !all.includes("http"), "no stream link in any event");
  });

  test("media_play refusals", async () => {
    await connect(t, jf);
    assert.match((await command<{ message: string }>("media_play", { itemId: "m1" })).message, /Pick a TV/);
    assert.match((await command<{ message: string }>("media_play", { displayId: "nope", itemId: "m1" })).message, /doesn't know that TV/);
    assert.match((await command<{ message: string }>("media_play", { displayId: "atv", itemId: "gone" })).message, /doesn't have that/);
  });
});

describe("the guest page for staff", () => {
  test("the box vouches for staff: the guest page offers the staff page; guests aren't told", async () => {
    const guest = (await (await fetch(t.url + "/api/public/state")).json()) as { staff?: boolean };
    assert.equal(guest.staff, undefined);
    const staff = (await (await fetch(t.url + "/api/public/state", { headers: { "x-bargames-via": "1", "x-bargames-staff": "1" } })).json()) as { staff?: boolean };
    assert.equal(staff.staff, true);
    // And /staff's sign-in needs no password for them.
    const status = (await (await fetch(t.url + "/api/admin/status", { headers: { "x-bargames-via": "1", "x-bargames-staff": "1" } })).json()) as { trusted: boolean };
    assert.equal(status.trusted, true);
    const trusted = await fetch(t.url + "/api/admin/trusted", { method: "POST", headers: { "x-bargames-via": "1", "x-bargames-staff": "1" } });
    assert.equal(trusted.status, 200);
  });
});

describe("box video adapter", () => {
  test("a box before 0.27.0 (no video on its TVs): nothing is listed", async () => {
    const bg = makeBarGames({ defaultName: "Movies", coreUrl: core.url, token: CORE_TOKEN });
    core.tvs = [{ id: "roku:1", name: "Bar", kind: "roku", online: true, canLaunch: [] }];
    const v = createBoxVideo(bg);
    assert.equal(v.problem(), null);
    assert.deepEqual(await v.tvs(), []);
  });

  test("standalone: needs a box", () => {
    assert.equal(createBoxVideo(makeBarGames({ defaultName: "Movies" })).problem(), "standalone");
  });

  test("with playVideo: only TVs the box can hand video to, calls passed through", async () => {
    const bg = makeBarGames({ defaultName: "Movies", coreUrl: core.url, token: CORE_TOKEN });
    const calls: unknown[] = [];
    Object.assign(bg, {
      playVideo: async (id: string, a: unknown) => (calls.push(["play", id, a]), { ok: true }),
      videoControl: async (id: string, a: unknown) => (calls.push(["control", id, a]), { ok: true }),
      videoStatus: async () => ({ state: "playing", position: 3 }),
    });
    core.tvs = [
      { id: "airplay:1", name: "Bar", kind: "airplay", online: true, canLaunch: [], video: { kind: "appletv", model: "AppleTV4KGen3" } },
      { id: "roku:2", name: "Patio", kind: "roku", online: true, canLaunch: [], video: { kind: "roku", model: "3930X" } },
      { id: "cast:3", name: "Browser TV", kind: "chromecast", online: true, canLaunch: [] },
      { id: "vb:4", name: "Den", kind: "venuebox", online: true, canLaunch: [], video: { kind: "venuebox", model: "Android TV", formats: { containers: ["mkv", "hls"], video: ["hevc"], audio: ["eac3"], maxHeight: 2160, seek: true, ranges: ["sdr", "hdr10"] } } },
      { id: "vb:5", name: "Odd", kind: "venuebox", online: true, canLaunch: [], video: { kind: "venuebox", model: "PC", formats: { containers: "mkv" } } },
    ];
    // bg.tvs() is gated on the manifest's media field by the box; our fake core answers anyway.
    const v = createBoxVideo(bg);
    assert.equal(v.problem(), null);
    const tvs = await v.tvs();
    assert.deepEqual(tvs.map((x) => [x.id, x.kind, x.model]), [
      ["airplay:1", "appletv", "AppleTV4KGen3"],
      ["roku:2", "roku", "3930X"],
      ["vb:4", "venuebox", "Android TV"],
      ["vb:5", "venuebox", "PC"],
    ]);
    assert.deepEqual(tvs[2]!.formats, { containers: ["mkv", "hls"], video: ["hevc"], audio: ["eac3"], maxHeight: 2160, seek: true, ranges: ["sdr", "hdr10"] });
    assert.equal(tvs[3]!.formats, undefined, "malformed formats are dropped (the TV gets the safe profile)");
    assert.equal(tvs[0]!.formats, undefined);
    await v.play("roku:2", { url: "http://m/x", title: "T" });
    await v.control("roku:2", { seek: 10 });
    assert.deepEqual(await v.status("roku:2"), { state: "playing", position: 3 });
    assert.equal(calls.length, 2);
  });
});
