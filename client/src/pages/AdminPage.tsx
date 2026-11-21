// Settings (bargames.json routes.admin "/admin"): the media server's address, its certificate,
// the sign-in as the venue's limited user, and per-TV playback settings.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BoxAdminLink, VenueAnnouncement } from "@bargames/gamekit/client";
import { bgUrl } from "@bargames/sdk/client";
import { normaliseServerUrl, PROFILE_IDS, TV_PROFILES, type AdminState, type TestResult, type TvInfo } from "@movies/shared";
import { api, ApiError } from "../api";
import { AuthGate, useStaffAuth } from "../components/Auth";
import { useVenue } from "../useVenue";

type Notify = (text: string, error?: boolean) => void;

function ServerCard({ state, reload, notify }: { state: AdminState; reload: () => Promise<void>; notify: Notify }) {
  const s = state.server;
  const [url, setUrl] = useState(s.url ?? "");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const preview = url.trim() ? normaliseServerUrl(url) : null;

  const run = async (fn: () => Promise<{ test: TestResult; notes?: string[] }>) => {
    setBusy(true);
    try {
      const r = await fn();
      setTest(r.test);
      setNotes(r.notes ?? []);
      await reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "That didn't work.", true);
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.setServer(url);
      setUrl(r.server.url ?? url);
      return r;
    });
  };

  return (
    <section className="card">
      <h2>Media server</h2>
      <p className="muted">The venue's Jellyfin server. It can be anywhere on the internet: the TVs stream straight from it, so it must let in the bar's internet address.</p>
      <form onSubmit={save} className="row-form">
        <label className="grow">
          Server address
          <input type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://media.example.org:8920/jellyfin" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <button className="primary" disabled={busy || !url.trim()}>
          Save and test
        </button>
        {s.url && (
          <button type="button" disabled={busy} onClick={() => void run(api.testServer)}>
            Test connection
          </button>
        )}
      </form>
      <p className="muted small">The full address: http:// or https://, the server name, the port and any path, e.g. http://host:8096 or https://host:8920/jellyfin. Jellyfin's usual ports are 8096 (http) and 8920 (https), but use whatever yours is.</p>
      {preview && !preview.ok && <p className="error">{preview.error}</p>}
      {preview?.ok && preview.notes.length > 0 && url.trim() !== s.url && <p className="muted small">{preview.notes.join(" ")}</p>}
      {notes.length > 0 && <p className="muted small">{notes.join(" ")}</p>}

      {test && (test.ok ? <p className="ok-line">✓ Connected: {test.serverName} (Jellyfin {test.version})</p> : <p className="error">{test.error}</p>)}
      {!test && s.url && s.serverName && <p className="ok-line">Last test: {s.serverName} (Jellyfin {s.version})</p>}
      {s.problem && <p className="error">{s.problem}</p>}

      {s.insecure && s.url && (
        <div className="warn">
          <strong>This address is http.</strong> The token in every link crosses the internet unencrypted. Use https if you can.
        </div>
      )}

      {test?.cert && (
        <div className="warn">
          <strong>{test.cert.reason}</strong>
          <p>
            If this is your own server's self-signed certificate, you can trust exactly this one. Check the fingerprint matches the one on your server before you do:
          </p>
          <code className="fp">{test.cert.fingerprint}</code>
          <p className="small muted">
            {test.cert.subject && <>Issued to {test.cert.subject}. </>}
            {test.cert.issuer && <>Issued by {test.cert.issuer}. </>}
            {test.cert.validTo && <>Valid until {test.cert.validTo}.</>}
          </p>
          <p>
            <strong>The TVs must trust the certificate too, and an Apple TV or Roku won't accept a self-signed one.</strong> Trusting it here lets this app browse the server, but the
            TVs' video links would still fail. With a self-signed certificate, use the server's http address for the stream (and accept the http warning), or get a real certificate (for
            example a free Let's Encrypt one).
          </p>
          <button className="primary" disabled={busy} onClick={() => void run(() => api.trust(test.cert!.fingerprint))}>
            Trust this certificate
          </button>
        </div>
      )}
      {s.pinned && (
        <div className="warn">
          <strong>Trusting one self-signed certificate.</strong> Fingerprint <code className="fp">{s.pinned}</code>
          <p className="small">The TVs can't use a self-signed certificate: their links will fail unless they reach the server another way.</p>
          <button disabled={busy} onClick={() => void run(async () => (await api.untrust(), { test: { ok: true } }))}>
            Stop trusting it
          </button>
        </div>
      )}
    </section>
  );
}

function SignInCard({ state, reload, notify }: { state: AdminState; reload: () => Promise<void>; notify: Notify }) {
  const s = state.server;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.signIn(username, password);
      setPassword("");
      notify("Signed in.");
      await reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "That didn't work.", true);
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    await api.signOut().catch(() => undefined);
    await reload();
  };
  return (
    <section className="card">
      <h2>Sign in to Jellyfin</h2>
      <p>
        <strong>Create a user that can only see the movie library. Its key is what the TVs' links carry.</strong> Anyone who sees a link (on the TV, on the network) could use that key, so
        give the user nothing else: not an admin, only the libraries you want on the TVs, with video playback and transcoding allowed.
      </p>
      {s.signedIn ? (
        <>
          <p className="ok-line">✓ Signed in as {s.userName}.</p>
          {s.userIsAdmin && (
            <div className="warn">
              <strong>This user is a Jellyfin administrator.</strong> Its key, in every TV link, could change the whole server. Make a limited user and sign in with that instead.
            </div>
          )}
          <button onClick={() => void signOut()}>Sign out</button>
        </>
      ) : (
        <form onSubmit={submit} className="row-form">
          <label>
            Jellyfin user
            <input autoCapitalize="none" autoCorrect="off" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </label>
          <label>
            Password
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="primary" disabled={busy || !username || !s.url}>
            Sign in
          </button>
        </form>
      )}
      <p className="muted small">The password is used once to sign in and isn't kept: only the server's access token is stored, on this box.</p>
    </section>
  );
}

function TvRow({ tv, notify, reload }: { tv: TvInfo; notify: Notify; reload: () => Promise<void> }) {
  const [cap, setCap] = useState(tv.capMbps == null ? "" : String(tv.capMbps));
  useEffect(() => setCap(tv.capMbps == null ? "" : String(tv.capMbps)), [tv.capMbps]);
  const save = async (patch: Record<string, unknown>) => {
    try {
      await api.saveTv(tv.displayId, patch);
      await reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "That didn't save.", true);
    }
  };
  const max = TV_PROFILES[tv.profile].maxBitrate / 1e6;
  return (
    <tr>
      <td>
        <strong>{tv.name}</strong>
        <div className="muted small">{[tv.kind, tv.model, tv.online ? "" : "offline"].filter(Boolean).join(" · ")}</div>
      </td>
      <td>
        <select value={tv.profileAuto ? "auto" : tv.profile} onChange={(e) => void save({ profile: e.target.value })}>
          <option value="auto">Automatic ({TV_PROFILES[tv.profile].label})</option>
          {PROFILE_IDS.map((p) => (
            <option key={p} value={p}>
              {TV_PROFILES[p].label}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input className="num" type="number" inputMode="decimal" min={1} max={200} placeholder={`${max}`} value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => cap !== (tv.capMbps == null ? "" : String(tv.capMbps)) && void save({ capMbps: cap === "" ? null : Number(cap) })} />{" "}
        <span className="muted small">Mbit/s</span>
      </td>
      <td>
        {TV_PROFILES[tv.profile].maxHeight > 1080 ? (
          <label className="check">
            <input type="checkbox" checked={tv.allow4k} onChange={(e) => void save({ allow4k: e.target.checked })} /> Allow 4K
          </label>
        ) : (
          <span className="muted small">1080p</span>
        )}
      </td>
    </tr>
  );
}

function TvsCard({ state, notify, reload }: { state: AdminState; notify: Notify; reload: () => Promise<void> }) {
  return (
    <section className="card">
      <h2>TVs</h2>
      <p className="muted">
        What each TV can play decides whether it gets the file as it is (full quality, original sound) or the server's converted stream. The bitrate cap keeps a TV under what the
        server's upload and the bar's internet can carry; leave it empty for the TV's own maximum. 4K off holds a 4K TV to 1080p.
      </p>
      {state.video.problem === "standalone" && <p className="muted">Not on a Bar Games box: there are no TVs to set up.</p>}
      {state.video.problem === "box-too-old" && <p className="muted">This box can't hand videos to TVs yet (it needs a box update).</p>}
      {!state.video.problem && !state.tvs.length && <p className="muted">The box has no TVs that can play videos. Movies plays on Apple TVs and Rokus, and needs box 0.27.0 or newer.</p>}
      {state.tvs.length > 0 && (
        <div className="table-wrap">
          <table className="tvs">
            <thead>
              <tr>
                <th>TV</th>
                <th>Type</th>
                <th>Bitrate cap</th>
                <th>4K</th>
              </tr>
            </thead>
            <tbody>
              {state.tvs.map((t) => (
                <TvRow key={t.displayId} tv={t} notify={notify} reload={reload} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AdminPage() {
  const venue = useVenue();
  const { phase, check, signOut } = useStaffAuth();
  const [state, setState] = useState<AdminState | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const notify: Notify = useCallback((text, error = false) => setNotice({ text, error }), []);
  const reload = useCallback(async () => {
    try {
      setState(await api.state());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void check();
    }
  }, [check]);
  useEffect(() => {
    document.title = "Movies settings";
  }, []);
  useEffect(() => {
    if (phase.kind === "ready") void reload();
  }, [phase.kind, reload]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  return (
    <div className="admin">
      <VenueAnnouncement ctx={venue} />
      <BoxAdminLink ctx={venue} />
      <AuthGate title="Movies settings" phase={phase} check={check}>
        <header className="top">
          <h1>Movies settings</h1>
          <nav>
            <a href={bgUrl("/")}>Pick a movie</a>
            <button className="link" onClick={() => void signOut()}>
              Sign out
            </button>
          </nav>
        </header>
        {notice && (
          <div className={`notice${notice.error ? " is-error" : ""}`} role="status">
            <span>{notice.text}</span>
            <button className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {!state ? (
          <p className="muted center-page">Loading…</p>
        ) : (
          <main className="admin-main">
            <ServerCard state={state} reload={reload} notify={notify} />
            <SignInCard state={state} reload={reload} notify={notify} />
            <TvsCard state={state} notify={notify} reload={reload} />
            <p className="muted small center">Plex (on the same server) is planned: Jellyfin only for now.</p>
          </main>
        )}
      </AuthGate>
    </div>
  );
}
