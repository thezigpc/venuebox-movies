// https with a self-signed certificate: refused until staff trust that one certificate by its
// SHA-256 fingerprint; any other certificate is still refused.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { createHttp, normaliseFingerprint, pinMatches, probeCertificate, HttpError } from "../src/http.js";
import { CERT, fakeJellyfin, PASSWORD, startApp, USER, type FakeJellyfin, type TestApp } from "./fakes.js";

const FP = new X509Certificate(CERT).fingerprint256;
const OTHER = "AA:".repeat(31) + "AA";

test("fingerprints: separators and case don't matter; junk isn't a pin", () => {
  assert.equal(normaliseFingerprint(FP.replace(/:/g, "").toLowerCase()), FP);
  assert.equal(normaliseFingerprint(`sha256:${FP}`), FP);
  assert.equal(normaliseFingerprint("abc"), "");
  assert.equal(pinMatches(FP.toLowerCase(), FP), true);
  assert.equal(pinMatches(OTHER, FP), false);
  assert.equal(pinMatches("", FP), false);
  assert.equal(pinMatches(null, null), false);
});

let jf: FakeJellyfin;
beforeEach(async () => {
  jf = await fakeJellyfin({ tls: true, basePath: "/jellyfin" });
});
afterEach(() => jf.close());

test("the HTTP client: refused without a pin, works with the right one, refused with another", async () => {
  const url = `${jf.url}/System/Info/Public`;
  await assert.rejects(createHttp()({ url }), (e: HttpError) => e.kind === "cert-untrusted" && /self-signed/.test(e.message));
  const ok = await createHttp({ pin: () => FP })({ url });
  assert.equal(ok.status, 200);
  assert.equal(ok.json<{ ServerName: string }>().ServerName, "Fake Jellyfin");
  await assert.rejects(createHttp({ pin: () => OTHER })({ url }), (e: HttpError) => e.kind === "pin-mismatch");
  // The pin only applies to https: plain http to the same pinned client is unaffected.
});

test("probe reads the certificate without trusting it", async () => {
  const c = await probeCertificate(jf.url);
  assert.equal(c.fingerprint, FP);
  assert.equal(c.trusted, false);
  assert.equal(c.selfSigned, true);
  assert.equal(c.subject, "localhost");
});

test("settings: first connect shows the certificate; trusting it makes everything work", async () => {
  const t: TestApp = await startAppWithRealHttp();
  try {
    const r = await t.api<{ value: { test: { ok: boolean; cert?: { fingerprint: string; selfSigned: boolean } } } }>("PUT", "/api/admin/server", { url: jf.url });
    assert.equal(r.body.value.test.ok, false);
    assert.equal(r.body.value.test.cert?.fingerprint, FP);
    assert.equal(r.body.value.test.cert?.selfSigned, true);

    // Only the certificate the server shows now can be trusted.
    const wrong = await t.api<{ error: string }>("POST", "/api/admin/server/trust", { fingerprint: OTHER });
    assert.equal(wrong.status, 400);
    const ok = await t.api<{ value: { test: { ok: boolean }; server: { pinned: string } } }>("POST", "/api/admin/server/trust", { fingerprint: FP });
    assert.equal(ok.body.value.test.ok, true);
    assert.equal(ok.body.value.server.pinned, FP);

    const s = await t.api("POST", "/api/admin/server/signin", { username: USER, password: PASSWORD });
    assert.equal(s.status, 200);
    const libs = await t.api<{ value: unknown[] }>("GET", "/api/admin/libraries");
    assert.equal(libs.body.value.length, 2);

    // Another address: the pin doesn't follow it.
    await t.api("PUT", "/api/admin/server", { url: jf.url.replace("127.0.0.1", "localhost") });
    assert.equal(t.app.store.settings.pin, null);
  } finally {
    await t.close();
  }
});

/** startApp uses createHttp() without the store's pin; this one uses the app's own client. */
async function startAppWithRealHttp(): Promise<TestApp> {
  const t = await startApp();
  await t.close();
  const { createApp } = await import("../src/app.js");
  const { makeBarGames } = await import("../src/bargames.js");
  const http = await import("node:http");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "movies-tls-"));
  const app = await createApp({ dataDir: dir, bg: makeBarGames({ defaultName: "Movies" }), adminPassword: "admin-password-123", video: t.tvs, pollMs: 60_000 });
  const server = http.createServer(app.app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await fetch(`${url}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "admin-password-123" }) });
  const token = ((await login.json()) as { token: string }).token;
  return {
    ...t,
    url,
    app,
    dir,
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
}
