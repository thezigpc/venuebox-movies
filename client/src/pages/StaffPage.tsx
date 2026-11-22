// The staff picker (bargames.json routes.host "/"), for the iPad: libraries, search, posters,
// a movie's details and "Play on this TV". The TVs and their remote live in one dock at the
// bottom: pick a TV and control it in the same place, with no scrolling between them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoxAdminLink, VenueAnnouncement } from "@bargames/gamekit/client";
import { bgUrl } from "@bargames/sdk/client";
import { clock, runtime, type Card, type FileDetails, type Library, type StaffState, type TvInfo } from "@movies/shared";
import { api, ApiError, img, type ControlAction, type ItemWithFit } from "../api";
import { AuthGate, useStaffAuth } from "../components/Auth";
import { useVenue } from "../useVenue";

const TV_KEY = "movies.tv";
const readTv = () => {
  try {
    return localStorage.getItem(TV_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveTv = (id: string) => {
  try {
    localStorage.setItem(TV_KEY, id);
  } catch {
    /* per-device convenience only */
  }
};

export function fileLine(f?: FileDetails): string {
  if (!f) return "";
  const parts: string[] = [];
  const h = f.video?.height ?? 0;
  if (h) parts.push(h >= 2000 ? "4K" : h >= 1000 ? "1080p" : h >= 700 ? "720p" : `${h}p`);
  if (f.video?.range && f.video.range !== "SDR") parts.push(f.video.range.startsWith("DOVI") ? "Dolby Vision" : f.video.range.replace("HDR10Plus", "HDR10+"));
  if (f.video?.codec) parts.push(f.video.codec.toUpperCase());
  if (f.audio?.codec) parts.push(`${f.audio.codec.toUpperCase()}${f.audio.channels ? ` ${f.audio.channels > 2 ? `${f.audio.channels - 1}.1` : f.audio.channels === 2 ? "stereo" : "mono"}` : ""}`);
  if (f.container) parts.push(f.container.split(",")[0]!.toUpperCase());
  return parts.join(" · ");
}

function Poster({ card, onOpen }: { card: Card; onOpen: (c: Card) => void }) {
  return (
    <button className={`poster kind-${card.kind}`} onClick={() => onOpen(card)}>
      <div className="poster-img">
        {card.poster ? <img src={img(card.poster)} alt="" loading="lazy" /> : <span className="poster-blank">{card.title.slice(0, 1)}</span>}
        {card.played && <span className="badge-played" aria-label="watched">✓</span>}
        {card.progress != null && (
          <span className="progress">
            <span style={{ width: `${Math.round(card.progress * 100)}%` }} />
          </span>
        )}
      </div>
      <span className="poster-title">{card.title}</span>
      <span className="poster-sub muted">{card.subtitle ?? card.year ?? ""}</span>
    </button>
  );
}

function stateWords(tv: TvInfo): string {
  if (!tv.online) return "Offline";
  const n = tv.now;
  if (!n) return "Ready";
  if (n.state === "starting") return "Starting…";
  if (n.state === "error") return "Problem";
  if (n.state === "paused") return "Paused";
  return "Playing";
}

/** The TVs and the selected TV's remote, always on screen. */
function Dock({ tvs, selected, onSelect, notify }: { tvs: TvInfo[]; selected: string; onSelect: (id: string) => void; notify: (t: string, err?: boolean) => void }) {
  const tv = tvs.find((t) => t.displayId === selected);
  const n = tv?.now;
  const [busy, setBusy] = useState(false);
  const control = async (a: ControlAction) => {
    if (!tv) return;
    setBusy(true);
    try {
      await api.control(tv.displayId, a);
    } catch (err) {
      notify(err instanceof Error ? err.message : "That didn't work.", true);
    } finally {
      setBusy(false);
    }
  };
  if (!tvs.length) return null;
  return (
    <div className="dock">
      <div className="dock-tvs" role="radiogroup" aria-label="TV">
        {tvs.map((t) => (
          <button key={t.displayId} role="radio" aria-checked={t.displayId === selected} className={`tv-chip${t.displayId === selected ? " is-on" : ""} st-${t.now?.state ?? (t.online ? "idle" : "offline")}`} onClick={() => onSelect(t.displayId)}>
            <span className="tv-name">{t.name}</span>
            <span className="tv-state">{t.now && t.now.state !== "error" ? t.now.title : stateWords(t)}</span>
          </button>
        ))}
      </div>
      {tv && (
        <div className="dock-remote">
          {n ? (
            <>
              <div className="np">
                {n.poster && <img className="np-poster" src={img(n.poster)} alt="" />}
                <div className="np-text">
                  <strong>{n.title}</strong>
                  <span className="muted">
                    {n.state === "error"
                      ? n.message
                      : `${stateWords(tv)} · ${clock(n.positionSec)}${n.durationSec ? ` / ${clock(n.durationSec)}` : ""} · ${n.method === "direct" ? "as it is" : "server converts"}${n.upNext ? ` · ${n.upNext}` : ""}`}
                  </span>
                  {n.durationSec ? (
                    <span className="progress wide">
                      <span style={{ width: `${Math.min(100, (n.positionSec / n.durationSec) * 100)}%` }} />
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="remote">
                {tv.canSeek && (
                  <button disabled={busy || n.state === "error"} onClick={() => void control("back")} aria-label="Back 30 seconds">
                    −30 s
                  </button>
                )}
                {n.state === "paused" ? (
                  <button className="primary" disabled={busy} onClick={() => void control("resume")}>
                    ▶ Resume
                  </button>
                ) : (
                  <button className="primary" disabled={busy || n.state !== "playing"} onClick={() => void control("pause")}>
                    ❚❚ Pause
                  </button>
                )}
                {tv.canSeek && (
                  <button disabled={busy || n.state === "error"} onClick={() => void control("forward")} aria-label="Forward 30 seconds">
                    +30 s
                  </button>
                )}
                <button className="danger" disabled={busy} onClick={() => void control("stop")}>
                  ■ Stop
                </button>
              </div>
            </>
          ) : (
            <p className="muted dock-idle">{tv.online ? `${tv.name} is ready. Pick something to play on it.` : `${tv.name} is offline.`}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Details({ id, tvs, tv, onTv, onOpen, onClose, notify }: { id: string; tvs: TvInfo[]; tv: string; onTv: (id: string) => void; onOpen: (c: Card) => void; onClose: () => void; notify: (t: string, err?: boolean) => void }) {
  const [item, setItem] = useState<ItemWithFit | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setItem(null);
    setError("");
    api.item(id).then(setItem, (err: Error) => setError(err.message));
  }, [id]);
  const target = tvs.find((t) => t.displayId === tv);
  const fit = item && target ? item.fit[target.displayId] : undefined;
  const container = item && (item.kind === "series" || item.kind === "season" || item.kind === "collection");

  const play = async (resume: boolean) => {
    if (!item || !target) return;
    setBusy(true);
    try {
      const r = await api.play(target.displayId, item.id, resume);
      notify(`Playing ${r.title} on ${target.name}.`);
      onClose();
    } catch (err) {
      notify(err instanceof Error ? err.message : "That didn't start.", true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        {error && <p className="error">{error}</p>}
        {!item && !error && <p className="muted">Loading…</p>}
        {item && (
          <div className="detail">
            <div className="detail-poster">{item.poster ? <img src={img(item.poster)} alt="" /> : <span className="poster-blank">{item.title.slice(0, 1)}</span>}</div>
            <div className="detail-body">
              <h2>{item.title}</h2>
              <p className="muted">{[item.subtitle ?? item.year, item.runtimeSec ? runtime(item.runtimeSec) : "", item.played ? "Watched" : ""].filter(Boolean).join(" · ")}</p>
              {item.file && <p className="file-line">{fileLine(item.file)}</p>}
              {item.overview && <p className="overview">{item.overview}</p>}

              {tvs.length > 0 && (
                <div className="play-on">
                  <span className="label">Play on</span>
                  <div className="seg">
                    {tvs.map((t) => (
                      <button key={t.displayId} className={t.displayId === tv ? "is-on" : ""} disabled={!t.online} onClick={() => onTv(t.displayId)}>
                        {t.name}
                      </button>
                    ))}
                  </div>
                  {fit && <p className={`fit ${fit.direct ? "ok" : ""}`}>{fit.direct ? "Plays as it is: full quality, original sound." : `The server converts it for this TV (${fit.reasons.join(", ")}).`}</p>}
                </div>
              )}
              {item.playable && target && (
                <div className="actions">
                  {item.resumeSec && !container && target.canSeek ? (
                    <>
                      <button className="primary big" disabled={busy || !target.online} onClick={() => void play(true)}>
                        ▶ Resume from {clock(item.resumeSec)}
                      </button>
                      <button className="big" disabled={busy || !target.online} onClick={() => void play(false)}>
                        Start over
                      </button>
                    </>
                  ) : (
                    <button className="primary big" disabled={busy || !target.online} onClick={() => void play(true)}>
                      ▶ {item.kind === "series" || item.kind === "season" ? "Play next episode" : item.kind === "collection" ? "Play the collection" : "Play on this TV"}
                    </button>
                  )}
                  {item.resumeSec && !container && !target.canSeek && <span className="muted small">This TV starts from the beginning (its player can't pick up at {clock(item.resumeSec)}).</span>}
                  {target.now && <span className="muted small">Replaces {target.now.title} on {target.name}.</span>}
                </div>
              )}
              {!tvs.length && <p className="muted">No TV here can play videos yet.</p>}
            </div>
            {item.children && item.children.length > 0 && (
              <div className="children">
                <h3>{item.kind === "series" ? "Seasons" : item.kind === "season" ? "Episodes" : "In this collection"}</h3>
                {item.kind === "season" ? (
                  <ul className="episodes">
                    {item.children.map((c) => (
                      <li key={c.id}>
                        <button onClick={() => onOpen(c)}>
                          <span>{c.subtitle?.split(" · ")[0]}</span> <strong>{c.title}</strong> {c.played && <span className="muted">✓</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="grid small">
                    {item.children.map((c) => (
                      <Poster key={c.id} card={c} onOpen={onOpen} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Browser({ state, notify }: { state: StaffState; notify: (t: string, err?: boolean) => void }) {
  const [libs, setLibs] = useState<Library[] | null>(null);
  const [lib, setLib] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Card[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string[]>([]);
  const videoTvs = state.tvs;
  const [tv, setTvState] = useState(readTv);
  const setTv = (id: string) => (setTvState(id), saveTv(id));
  const selected = videoTvs.some((t) => t.displayId === tv) ? tv : (videoTvs[0]?.displayId ?? "");

  useEffect(() => {
    api.libraries().then(
      (l) => {
        setLibs(l);
        setLib((cur) => cur || l[0]?.id || "");
      },
      (err: Error) => setError(err.message),
    );
  }, []);
  useEffect(() => {
    if (!lib) return;
    setCards([]);
    setPage(0);
    api.browse(lib, 0).then(
      (p) => (setCards(p.items), setTotal(p.total)),
      (err: Error) => setError(err.message),
    );
  }, [lib]);
  const more = () => {
    const next = page + 1;
    api.browse(lib, next).then((p) => (setCards((c) => [...c, ...p.items]), setPage(next)), (err: Error) => notify(err.message, true));
  };
  // Search as you type, a moment after the last key.
  const searchTimer = useRef<number>();
  useEffect(() => {
    window.clearTimeout(searchTimer.current);
    if (q.trim().length < 2) return void setResults(null);
    searchTimer.current = window.setTimeout(() => api.search(q).then(setResults, (err: Error) => notify(err.message, true)), 300);
  }, [q, notify]);

  const openCard = (c: Card) => setOpen((o) => [...o, c.id]);
  const list = results ?? cards;

  return (
    <>
      <div className="toolbar">
        <input className="search" type="search" placeholder="Search movies and shows" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" />
        {!results && libs && libs.length > 1 && (
          <div className="seg libs">
            {libs.map((l) => (
              <button key={l.id} className={l.id === lib ? "is-on" : ""} onClick={() => setLib(l.id)}>
                {l.title}
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <p className="error pad">{error}</p>}
      {libs && !libs.length && <p className="muted pad">This Jellyfin user can't see any movie or TV libraries. Give it access to the movie library on the server.</p>}
      {results && !results.length && <p className="muted pad">Nothing found for “{q}”.</p>}
      <div className="grid">
        {list.map((c) => (
          <Poster key={c.id} card={c} onOpen={openCard} />
        ))}
      </div>
      {!results && cards.length < total && (
        <div className="center pad">
          <button onClick={more}>Show more ({total - cards.length} left)</button>
        </div>
      )}
      <Dock tvs={videoTvs} selected={selected} onSelect={setTv} notify={notify} />
      {open.length > 0 && <Details id={open[open.length - 1]!} tvs={videoTvs} tv={selected} onTv={setTv} onOpen={openCard} onClose={() => setOpen((o) => o.slice(0, -1))} notify={notify} />}
    </>
  );
}

function VideoBanner({ state }: { state: StaffState }) {
  const p = state.video.problem;
  if (p === "standalone") return <p className="banner">This copy isn't on a Bar Games box, so it can't play on TVs. Browsing still works.</p>;
  if (p === "box-too-old") return <p className="banner">This box can't hand videos to TVs yet: it needs a box update with video playback.</p>;
  if (state.video.fake) return <p className="banner dev">Dev mode: pretend TVs. Each play checks the stream link really works.</p>;
  if (!state.tvs.length) return <p className="banner">The box has no TVs that can play videos. Movies plays on Apple TVs and Rokus (box 0.27.0 or newer) and Venuebox apps (box 0.28.0 or newer).</p>;
  return null;
}

export function StaffPage() {
  const venue = useVenue();
  const { phase, check, signOut } = useStaffAuth();
  const [state, setState] = useState<StaffState | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), []);

  const reload = useCallback(async () => {
    try {
      setState(await api.staffState());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void check();
    }
  }, [check]);
  useEffect(() => {
    document.title = state?.name ?? "Movies";
  }, [state?.name]);
  useEffect(() => {
    if (phase.kind !== "ready") return;
    void reload();
    const t = setInterval(() => !document.hidden && void reload(), 3000);
    return () => clearInterval(t);
  }, [phase.kind, reload]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);
  const name = useMemo(() => state?.name ?? "Movies", [state?.name]);

  return (
    <div className="staff">
      <VenueAnnouncement ctx={venue} />
      <BoxAdminLink ctx={venue} />
      <AuthGate title={name} phase={phase} check={check}>
        <header className="top">
          <h1>{name}</h1>
          <nav>
            <a href={bgUrl("/admin")}>Settings</a>
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
        ) : !state.ready ? (
          <div className="card pad-card">
            <h2>Not set up yet</h2>
            <p>Connect the venue's media server first: its address and a sign-in.</p>
            <a className="button primary" href={bgUrl("/admin")}>
              Open settings
            </a>
          </div>
        ) : (
          <>
            <VideoBanner state={state} />
            <Browser state={state} notify={notify} />
          </>
        )}
      </AuthGate>
    </div>
  );
}
