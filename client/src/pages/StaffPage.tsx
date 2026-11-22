// The staff page (bargames.json routes.host "/staff"): browse the media server, play on a TV,
// and control it. One layout per device:
//   phone: the list, a mini player bar, and a full-screen remote;
//   iPad portrait: the list with a dock (TVs and the remote) at the bottom;
//   iPad landscape: the list with a panel (TVs, the remote, the vote) at the side.
// With no media server it still runs tonight's list and the guest vote, typed by hand.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BoxAdminLink, VenueAnnouncement } from "@bargames/gamekit/client";
import { bgUrl } from "@bargames/sdk/client";
import { clock, runtime, type Card, type FileDetails, type Library, type StaffState, type TvInfo, type VoteCloses, type VoteStaff } from "@movies/shared";
import { api, ApiError, img, type ControlAction, type ItemWithFit } from "../api";
import { AuthGate, useStaffAuth } from "../components/Auth";
import { IconBack, IconCheck, IconDown, IconGear, IconPause, IconPlay, IconPlus, IconSearch, IconStop, IconUp, IconVote, IconX } from "../components/Icons";
import { defaults, hasChoices, isDefault, toChoice, trackWords, TrackPicker, type Picked } from "../components/Tracks";
import { useVenue } from "../useVenue";

type Notify = (text: string, error?: boolean) => void;
type Layout = "phone" | "portrait" | "landscape";

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

function useLayout(): Layout {
  const read = (): Layout => (window.innerWidth < 700 ? "phone" : window.innerWidth >= 1000 && window.innerWidth > window.innerHeight ? "landscape" : "portrait");
  const [layout, setLayout] = useState<Layout>(read);
  useEffect(() => {
    const on = () => setLayout(read());
    window.addEventListener("resize", on);
    window.addEventListener("orientationchange", on);
    return () => (window.removeEventListener("resize", on), window.removeEventListener("orientationchange", on));
  }, []);
  return layout;
}

export function fileBadges(f?: FileDetails): string[] {
  if (!f) return [];
  const out: string[] = [];
  const h = f.video?.height ?? 0;
  if (h) out.push(h >= 2000 ? "4K" : h >= 1000 ? "1080p" : h >= 700 ? "720p" : `${h}p`);
  if (f.video?.range && f.video.range !== "SDR") out.push(f.video.range.startsWith("DOVI") ? "Dolby Vision" : f.video.range.replace("HDR10Plus", "HDR10+"));
  if (f.audio?.channels) out.push(f.audio.channels > 2 ? `${f.audio.channels - 1}.1` : f.audio.channels === 2 ? "Stereo" : "Mono");
  return out;
}

function Poster({ card, onOpen }: { card: Card; onOpen: (c: Card) => void }) {
  return (
    <button className={`poster kind-${card.kind}`} onClick={() => onOpen(card)}>
      <div className="poster-img">
        {card.poster ? <img src={img(card.poster)} alt="" loading="lazy" /> : <span className="poster-blank">{card.title.slice(0, 1)}</span>}
        {card.played && (
          <span className="badge-played" aria-label="watched">
            <IconCheck size={14} />
          </span>
        )}
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

function tvWords(tv: TvInfo): string {
  if (!tv.online) return "Offline";
  const n = tv.now;
  if (!n) return "Ready";
  if (n.state === "starting") return "Starting…";
  if (n.state === "error") return "Problem";
  return n.state === "paused" ? "Paused" : "Playing";
}
const tvClass = (tv: TvInfo) => `st-${tv.now?.state ?? (tv.online ? "idle" : "offline")}`;

function TvTabs({ tvs, selected, onSelect, detail }: { tvs: TvInfo[]; selected: string; onSelect: (id: string) => void; detail?: boolean }) {
  return (
    <div className="mv-tvs" role="tablist" aria-label="TV">
      {tvs.map((t) => (
        <button key={t.displayId} role="tab" aria-selected={t.displayId === selected} className={`mv-tv ${tvClass(t)}${t.displayId === selected ? " is-on" : ""}`} onClick={() => onSelect(t.displayId)}>
          <span className="mv-tv-name">{t.name}</span>
          <span className="mv-tv-state">{detail && t.now && t.now.state !== "error" ? `${tvWords(t)} · ${t.now.title}` : tvWords(t)}</span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ the remote

function useRemote(tv: TvInfo | undefined, notify: Notify, reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, fail = "That didn't work.") => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : fail, true);
    } finally {
      setBusy(false);
    }
  };
  const control = (a: ControlAction) => tv && run(() => api.control(tv.displayId, a));
  const seek = (sec: number) => tv && run(() => api.seek(tv.displayId, sec));
  return { busy, run, control, seek };
}

function Scrubber({ tv, onSeek, disabled }: { tv: TvInfo; onSeek: (sec: number) => void; disabled: boolean }) {
  const n = tv.now!;
  const [drag, setDrag] = useState<number | null>(null);
  const pos = drag ?? n.positionSec;
  if (!n.durationSec) return <div className="mv-times muted small">{clock(n.positionSec)}</div>;
  return (
    <div className="mv-scrub">
      <input
        type="range"
        min={0}
        max={n.durationSec}
        step={1}
        value={Math.min(pos, n.durationSec)}
        disabled={disabled || !tv.canSeek}
        aria-label="Position in the movie"
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => drag != null && (onSeek(drag), setDrag(null))}
        onKeyUp={() => drag != null && (onSeek(drag), setDrag(null))}
        onBlur={() => setDrag(null)}
      />
      <div className="mv-times muted small">
        <span>{clock(pos)}</span>
        <span>−{clock(Math.max(0, n.durationSec - pos))}</span>
      </div>
    </div>
  );
}

function Transport({ tv, r, big }: { tv: TvInfo; r: ReturnType<typeof useRemote>; big?: boolean }) {
  const n = tv.now!;
  const off = r.busy || n.state === "error";
  return (
    <div className={`mv-transport${big ? " is-big" : ""}`}>
      {tv.canSeek && (
        <button className="mv-round" disabled={off} onClick={() => void r.control("back")} aria-label="Back 30 seconds">
          −30
        </button>
      )}
      {n.state === "paused" ? (
        <button className="mv-round is-main" disabled={r.busy} onClick={() => void r.control("resume")} aria-label="Resume">
          <IconPlay size={big ? 30 : 26} />
        </button>
      ) : (
        <button className="mv-round is-main" disabled={r.busy || n.state !== "playing"} onClick={() => void r.control("pause")} aria-label="Pause">
          <IconPause size={big ? 30 : 26} />
        </button>
      )}
      {tv.canSeek && (
        <button className="mv-round" disabled={off} onClick={() => void r.control("forward")} aria-label="Forward 30 seconds">
          +30
        </button>
      )}
    </div>
  );
}

/** Audio and subtitles of what's playing: two buttons that open the picker. */
function TrackButtons({ tv, notify, reload }: { tv: TvInfo; notify: Notify; reload: () => Promise<void> }) {
  const n = tv.now!;
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Picked>({ sub: null });
  const [busy, setBusy] = useState(false);
  const key = `${tv.displayId}|${n.itemId}`;
  useEffect(() => setOpen(false), [key]);
  if (!hasChoices(n.tracks) || n.state === "error") return null;
  const tracks = n.tracks;
  const audio = tracks.audio.find((a) => a.index === n.audioIndex);
  const sub = n.subtitleIndex != null ? tracks.subtitles.find((s) => s.index === n.subtitleIndex) : undefined;
  const start = () => (setPicked({ ...(n.audioIndex != null ? { audio: n.audioIndex } : {}), sub: n.subtitleIndex ?? null }), setOpen(true));
  const unchanged = picked.sub === (n.subtitleIndex ?? null) && (picked.audio ?? null) === (n.audioIndex ?? null);
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.tracks(tv.displayId, toChoice(tracks, picked));
      notify(r.inPlace ? `Switched on ${tv.name}.` : tv.canSeek ? `Switching on ${tv.name}: it picks up where it was.` : `Switching on ${tv.name}: it starts again from the beginning.`);
      setOpen(false);
      await reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "That didn't change.", true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="mv-two">
        <button className="mv-field" onClick={() => (open ? setOpen(false) : start())} aria-expanded={open}>
          <span className="mv-field-label">Audio</span>
          <span className="mv-field-value">{audio?.label ?? "Default"}</span>
        </button>
        <button className="mv-field" onClick={() => (open ? setOpen(false) : start())} aria-expanded={open}>
          <span className="mv-field-label">Subtitles</span>
          <span className="mv-field-value">{sub?.label ?? "Off"}</span>
        </button>
      </div>
      {open && (
        <div className="mv-tracks-panel">
          <TrackPicker tracks={tracks} value={picked} onChange={setPicked} disabled={busy} native={tv.tracksNative} direct={n.method === "direct"} />
          {!tv.canSeek && !tv.tracksNative && <p className="tracks-note">{tv.name} can't start part-way: changing these starts the movie again from the beginning.</p>}
          <div className="mv-two">
            <button className="primary" disabled={busy || unchanged} onClick={() => void apply()}>
              {tv.tracksNative ? "Switch" : tv.canSeek ? `Switch (picks up at ${clock(n.positionSec)})` : "Switch (starts over)"}
            </button>
            <button disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** The vote's winner waiting for this TV. */
function UpNext({ tv, vote, r }: { tv: TvInfo; vote: VoteStaff; r: ReturnType<typeof useRemote> }) {
  if (!vote.winner || vote.winnerDisplayId !== tv.displayId) return null;
  return (
    <div className="mv-upnext">
      <span className="mv-upnext-text">
        <span className="mv-field-label">Up next · won the vote</span>
        <strong>{vote.winner.title}</strong>
      </span>
      <button disabled={r.busy} onClick={() => void r.run(() => api.votePlay())}>
        Play now
      </button>
    </div>
  );
}

function NowLine({ tv }: { tv: TvInfo }) {
  const n = tv.now!;
  if (n.state === "error") return <span className="error small">{n.message}</span>;
  const tracks = trackWords(n.tracks, n.audioIndex, n.subtitleIndex);
  return <span className="muted small">{[n.method === "direct" ? "Plays as it is" : "The server converts it", tracks, n.upNext].filter(Boolean).join(" · ")}</span>;
}

/** The selected TV's remote. Laid out by CSS for the dock, the side panel or the full screen. */
function Remote({ tv, vote, variant, notify, reload }: { tv: TvInfo; vote: VoteStaff; variant: "dock" | "panel" | "full"; notify: Notify; reload: () => Promise<void> }) {
  const r = useRemote(tv, notify, reload);
  const n = tv.now;
  if (!n)
    return (
      <div className={`mv-remote is-${variant}`}>
        <p className="muted mv-idle">{tv.online ? `${tv.name} is ready. Pick something to play on it.` : `${tv.name} is offline.`}</p>
        <UpNext tv={tv} vote={vote} r={r} />
      </div>
    );
  return (
    <div className={`mv-remote is-${variant}`}>
      <div className="mv-now">
        {n.poster ? <img className="mv-now-poster" src={img(n.poster)} alt="" /> : <span className="mv-now-poster blank" />}
        <div className="mv-now-text">
          <span className={`mv-now-state ${tvClass(tv)}`}>
            {tvWords(tv)} on {tv.name}
          </span>
          <strong className="mv-now-title">{n.title}</strong>
          {n.subtitle && <span className="muted small">{n.subtitle}</span>}
          <NowLine tv={tv} />
        </div>
      </div>
      <Scrubber tv={tv} onSeek={(s) => void r.seek(s)} disabled={r.busy || n.state === "error"} />
      <Transport tv={tv} r={r} big={variant === "full"} />
      <TrackButtons tv={tv} notify={notify} reload={reload} />
      <UpNext tv={tv} vote={vote} r={r} />
      <button className="mv-stop" disabled={r.busy} onClick={() => void r.control("stop")}>
        <IconStop size={14} /> Stop {tv.name}
      </button>
    </div>
  );
}

/** Phone: one line of what's playing, below the list. Opens the full remote. */
function MiniBar({ tv, onOpen, notify, reload }: { tv: TvInfo; onOpen: () => void; notify: Notify; reload: () => Promise<void> }) {
  const r = useRemote(tv, notify, reload);
  const n = tv.now;
  return (
    <div className="mv-mini">
      {n?.poster ? <img className="mv-mini-poster" src={img(n.poster)} alt="" /> : <span className="mv-mini-poster blank" />}
      <button className="mv-mini-text" onClick={onOpen}>
        <span className={`mv-now-state ${tvClass(tv)}`}>{n ? `${tvWords(tv)} on ${tv.name}` : tv.name}</span>
        <strong>{n ? n.title : tv.online ? "Ready" : "Offline"}</strong>
        {n?.durationSec ? (
          <span className="mv-bar">
            <span style={{ width: `${Math.min(100, (n.positionSec / n.durationSec) * 100)}%` }} />
          </span>
        ) : null}
      </button>
      {n && n.state !== "error" && (
        <button className="mv-round is-main is-small" disabled={r.busy || n.state === "starting"} onClick={() => void r.control(n.state === "paused" ? "resume" : "pause")} aria-label={n.state === "paused" ? "Resume" : "Pause"}>
          {n.state === "paused" ? <IconPlay size={20} /> : <IconPause size={20} />}
        </button>
      )}
      <button className="mv-round is-small" onClick={onOpen} aria-label="Open the remote">
        <IconUp />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ the guest vote and tonight's list

const votesWords = (n: number) => (n === 1 ? "1 vote" : `${n} votes`);

function VoteSummary({ vote, tvs, onOpen, notify, reload }: { vote: VoteStaff; tvs: TvInfo[]; onOpen: () => void; notify: Notify; reload: () => Promise<void> }) {
  const r = useRemote(undefined, notify, reload);
  const tv = tvs.find((t) => t.displayId === vote.displayId);
  if (!vote.open && !vote.winner && !vote.options.length) return null;
  return (
    <div className="mv-votecard">
      <div className="mv-votecard-head">
        <strong>{vote.open ? `Guest vote${tv ? ` · next on ${tv.name}` : ""}` : vote.winner ? "The vote's winner" : "Guest vote (not open yet)"}</strong>
        {vote.open && vote.closesInSec != null && <span className="g-closes">{clock(vote.closesInSec)} left</span>}
      </div>
      {vote.winner && !vote.open ? (
        <span>
          {vote.winner.title} <span className="muted">({votesWords(vote.winner.votes)})</span>
        </span>
      ) : (
        [...vote.options]
          .sort((a, b) => b.votes - a.votes)
          .slice(0, 3)
          .map((o) => (
            <div key={o.itemId} className="mv-votecard-row">
              <span>{o.title}</span>
              <span className="muted">{vote.open ? votesWords(o.votes) : ""}</span>
            </div>
          ))
      )}
      <div className="mv-two">
        <button onClick={onOpen}>{vote.open ? "See the vote" : "Open it"}</button>
        {vote.open ? (
          <button disabled={r.busy} onClick={() => void r.run(() => api.voteClose())}>
            Close it now
          </button>
        ) : vote.winner ? (
          <button disabled={r.busy} onClick={() => void r.run(() => api.voteClear())}>
            Clear
          </button>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}

function VoteSheet({ state, selectedTv, onClose, notify, reload }: { state: StaffState; selectedTv: string; onClose: () => void; notify: Notify; reload: () => Promise<void> }) {
  const vote = state.vote;
  const tvs = state.tvs;
  const r = useRemote(undefined, notify, reload);
  const [title, setTitle] = useState("");
  const [tv, setTv] = useState(selectedTv);
  const [closes, setCloses] = useState<VoteCloses>("time");
  const [minutes, setMinutes] = useState(10);
  // Off unless staff ask: they review the result and press play.
  const [autoPlay, setAutoPlay] = useState(false);
  const target = tvs.find((t) => t.displayId === tv);
  const allManual = vote.options.length > 0 && vote.options.every((o) => o.manual);
  const addTyped = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    void r.run(async () => (await api.voteAdd({ title }), setTitle("")));
  };
  const open = () => void r.run(() => api.voteOpen({ ...(target && !allManual ? { displayId: target.displayId } : {}), closes: closes === "movie-end" && (!target || allManual) ? "manual" : closes, minutes, autoPlay }));
  const most = Math.max(1, ...vote.options.map((o) => o.votes));

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet mv-sheet" role="dialog" aria-modal="true" aria-label="Guest vote" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-close" onClick={onClose} aria-label="Close">
          <IconX />
        </button>
        <h2 className="mv-sheet-title">Guest vote</h2>
        <p className="muted">Guests pick the next movie from the ones you choose here. They vote on this app's guest page, from the venue's games list.</p>
        {vote.note && <p className="mv-note">{vote.note}</p>}

        {vote.winner && !vote.open && (
          <div className="mv-votecard">
            <strong>
              The result: {vote.winner.title} won ({votesWords(vote.winner.votes)})
            </strong>
            {vote.results?.map((x, i) => (
              <div key={`${x.title}-${i}`} className="mv-votecard-row">
                <span>{x.title}</span>
                <span className="muted">{votesWords(x.votes)}</span>
              </div>
            ))}
            {vote.winnerDisplayId && <span className="muted small">Nothing starts until you press play{vote.autoPlay ? ", or until the movie on that TV ends" : ""}.</span>}
            <div className="mv-two">
              {vote.winnerDisplayId ? (
                <button className="primary" disabled={r.busy} onClick={() => void r.run(() => api.votePlay())}>
                  <IconPlay size={16} /> Play it on {vote.winnerTvName ?? "the TV"}
                </button>
              ) : (
                <span />
              )}
              <button disabled={r.busy} onClick={() => void r.run(() => api.voteClear())}>
                Don't play it: clear
              </button>
            </div>
          </div>
        )}

        {vote.open ? (
          <>
            <div className="mv-votecard-head">
              <h3 className="mv-h">
                {vote.total === 1 ? "1 guest has voted" : `${vote.total} guests have voted`}
                {vote.tvName ? ` · next on ${vote.tvName}` : ""}
              </h3>
              {vote.closesInSec != null && <span className="g-closes">{clock(vote.closesInSec)} left</span>}
            </div>
            {vote.options.map((o) => (
              <div key={o.itemId} className="g-opt">
                <span className="g-opt-fill" style={{ width: `${Math.round((o.votes / most) * 100)}%`, opacity: o.votes ? 0.14 : 0 }} />
                <span className="g-opt-text">
                  <strong>{o.title}</strong>
                </span>
                <span>{votesWords(o.votes)}</span>
              </div>
            ))}
            <p className="muted small">{vote.closes === "movie-end" ? "Closes when the movie on that TV ends." : vote.closes === "manual" ? "Stays open until you close it." : ""}</p>
            <div className="mv-two">
              <button className="primary" disabled={r.busy} onClick={() => void r.run(() => api.voteClose())}>
                Close the vote now
              </button>
              <button disabled={r.busy} onClick={() => void r.run(() => api.voteClear())}>
                Cancel the vote
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="mv-h">Movies in the vote</h3>
            {!vote.options.length && <p className="muted">None yet. {state.ready ? 'Open a movie and press "Add to a vote", or type one here.' : "Type the movies here."}</p>}
            {vote.options.map((o) => (
              <div key={o.itemId} className="mv-listrow">
                {o.poster ? <img className="mv-listrow-poster" src={img(o.poster)} alt="" /> : <span className="mv-listrow-poster blank">{o.title.slice(0, 1)}</span>}
                <span className="mv-listrow-text">
                  <strong>{o.title}</strong>
                  <span className="muted small">{o.manual ? "Typed in: staff put it on" : [o.year, o.runtimeSec ? runtime(o.runtimeSec) : ""].filter(Boolean).join(" · ")}</span>
                </span>
                <button className="mv-icon" disabled={r.busy} onClick={() => void r.run(() => api.voteRemove(o.itemId))} aria-label={`Remove ${o.title} from the vote`}>
                  <IconX size={18} />
                </button>
              </div>
            ))}
            <form className="mv-addrow" onSubmit={addTyped}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Type a movie's name" aria-label="A movie to add to the vote" maxLength={120} />
              <button disabled={r.busy || !title.trim()}>
                <IconPlus size={16} /> Add
              </button>
            </form>

            {tvs.length > 0 && !allManual && (
              <>
                <h3 className="mv-h">The winner plays on</h3>
                <div className="mv-choice">
                  {tvs.map((t) => (
                    <button key={t.displayId} aria-pressed={t.displayId === tv} className={t.displayId === tv ? "is-on" : ""} onClick={() => setTv(t.displayId)}>
                      {t.name}
                    </button>
                  ))}
                </div>
              </>
            )}
            <h3 className="mv-h">Voting closes</h3>
            <div className="mv-choice">
              <button aria-pressed={closes === "time"} className={closes === "time" ? "is-on" : ""} onClick={() => setCloses("time")}>
                After a set time
              </button>
              {target?.now && !allManual && (
                <button aria-pressed={closes === "movie-end"} className={closes === "movie-end" ? "is-on" : ""} onClick={() => setCloses("movie-end")}>
                  When this movie ends
                </button>
              )}
              <button aria-pressed={closes === "manual"} className={closes === "manual" ? "is-on" : ""} onClick={() => setCloses("manual")}>
                When I close it
              </button>
            </div>
            {closes === "time" && (
              <div className="mv-choice">
                {[5, 10, 20, 30].map((m) => (
                  <button key={m} aria-pressed={minutes === m} className={minutes === m ? "is-on" : ""} onClick={() => setMinutes(m)}>
                    {m} min
                  </button>
                ))}
              </div>
            )}
            {target && !allManual && (
              <label className="check">
                <input type="checkbox" checked={autoPlay} onChange={(e) => setAutoPlay(e.target.checked)} /> Start the winner by itself when the TV is free. Leave this off to see the result first and press play yourself.
              </label>
            )}
            {(allManual || !target) && vote.options.length > 0 && <p className="muted small">A typed-in winner can't start by itself: you'll be told which movie won, to put it on.</p>}
            <button className="primary big" disabled={r.busy || vote.options.length < 2} onClick={open}>
              Open the vote
            </button>
            {vote.options.length < 2 && <p className="muted small">A vote needs at least two movies.</p>}
          </>
        )}
      </div>
    </div>
  );
}

/** "Playing tonight", typed by staff for the guest page. */
function Tonight({ state, notify, reload }: { state: StaffState; notify: Notify; reload: () => Promise<void> }) {
  const r = useRemote(undefined, notify, reload);
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    void r.run(async () => (await api.tonightAdd(title, when), setTitle(""), setWhen("")));
  };
  return (
    <section className="mv-tonight">
      <h2 className="mv-h">Playing tonight (shown to guests)</h2>
      {!state.tonight.length && <p className="muted">Nothing listed. Type what's on tonight and guests see it on the guest page.</p>}
      {state.tonight.map((e) => (
        <div key={e.id} className="mv-listrow">
          <span className="mv-listrow-text">
            <strong>{e.title}</strong>
            {e.when && <span className="muted small">{e.when}</span>}
          </span>
          <button aria-pressed={e.onNow} className={`mv-pill${e.onNow ? " is-on" : ""}`} disabled={r.busy} onClick={() => void r.run(() => api.tonightSet(e.id, { onNow: !e.onNow }))}>
            {e.onNow ? "On now" : "Mark on now"}
          </button>
          <button className="mv-icon" disabled={r.busy} onClick={() => void r.run(() => api.tonightRemove(e.id))} aria-label={`Remove ${e.title}`}>
            <IconX size={18} />
          </button>
        </div>
      ))}
      <form className="mv-addrow" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Movie name" aria-label="Movie name" maxLength={120} />
        <input className="mv-when" value={when} onChange={(e) => setWhen(e.target.value)} placeholder="When or where (optional)" aria-label="When or where" maxLength={60} />
        <button disabled={r.busy || !title.trim()}>
          <IconPlus size={16} /> Add
        </button>
      </form>
    </section>
  );
}

// ------------------------------------------------------------------ a movie's details

function Details({ id, tvs, tv, onTv, onOpen, onClose, notify, reload, phone }: { id: string; tvs: TvInfo[]; tv: string; onTv: (id: string) => void; onOpen: (c: Card) => void; onClose: () => void; notify: Notify; reload: () => Promise<void>; phone: boolean }) {
  const [item, setItem] = useState<ItemWithFit | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Picked>({ sub: null });
  useEffect(() => {
    setItem(null);
    setError("");
    api.item(id).then(
      (it) => (setItem(it), setPicked(defaults(it.tracks))),
      (err: Error) => setError(err.message),
    );
  }, [id]);
  const single = !!item && (item.kind === "movie" || item.kind === "episode");
  const tracks = item && single && hasChoices(item.tracks) ? item.tracks : undefined;
  const plain = isDefault(item?.tracks, picked);
  const target = tvs.find((t) => t.displayId === tv);
  const fit = item && target ? item.fit[target.displayId] : undefined;

  const play = async (resume: boolean) => {
    if (!item || !target) return;
    setBusy(true);
    try {
      const r = await api.play(target.displayId, item.id, resume, tracks ? toChoice(tracks, picked) : {});
      notify(`Playing ${r.title} on ${target.name}.`);
      await reload();
      onClose();
    } catch (err) {
      notify(err instanceof Error ? err.message : "That didn't start.", true);
    } finally {
      setBusy(false);
    }
  };
  const addToVote = async () => {
    if (!item) return;
    setBusy(true);
    try {
      await api.voteAdd({ itemId: item.id });
      notify(`${item.title} is in the guest vote. Open "Guest vote" to start it.`);
      await reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "That didn't add.", true);
    } finally {
      setBusy(false);
    }
  };
  const playLabel = item?.kind === "series" || item?.kind === "season" ? "Play next episode" : item?.kind === "collection" ? "Play the collection" : "Play";
  const canResume = !!item?.resumeSec && single && !!target?.canSeek;

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet mv-sheet mv-details" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className={phone ? "mv-backbtn" : "sheet-close"} onClick={onClose} aria-label="Close">
          {phone ? (
            <>
              <IconBack /> Back
            </>
          ) : (
            <IconX />
          )}
        </button>
        {error && <p className="error">{error}</p>}
        {!item && !error && <p className="muted">Loading…</p>}
        {item && (
          <>
            <div className="mv-details-top">
              <div className="mv-details-poster">{item.poster ? <img src={img(item.poster)} alt="" /> : <span className="poster-blank">{item.title.slice(0, 1)}</span>}</div>
              <div className="mv-details-text">
                <h2>{item.title}</h2>
                <span className="muted">{[item.subtitle ?? item.year, item.runtimeSec ? runtime(item.runtimeSec) : "", item.played ? "Watched" : ""].filter(Boolean).join(" · ")}</span>
                {item.file && (
                  <div className="mv-badges">
                    {fileBadges(item.file).map((b) => (
                      <span key={b}>{b}</span>
                    ))}
                  </div>
                )}
                {item.overview && <p className="overview">{item.overview}</p>}
              </div>
            </div>

            {item.playable && tvs.length > 0 && (
              <>
                <h3 className="mv-h">Play on</h3>
                <div className="mv-tvs is-grid">
                  {tvs.map((t) => (
                    <button key={t.displayId} aria-pressed={t.displayId === tv} disabled={!t.online} className={`mv-tv ${tvClass(t)}${t.displayId === tv ? " is-on" : ""}`} onClick={() => onTv(t.displayId)}>
                      <span className="mv-tv-name">{t.name}</span>
                      <span className="mv-tv-state">{t.now && t.now.state !== "error" ? `${tvWords(t)} · ${t.now.title}` : tvWords(t)}</span>
                    </button>
                  ))}
                </div>
                {fit && target && (plain || (target.tracksNative && fit.direct)) && (
                  <p className={`fit ${fit.direct ? "ok" : ""}`}>{fit.direct ? `Plays as it is on ${target.name}: full quality, original sound.` : `The server converts it for ${target.name} (${fit.reasons.join(", ")}).`}</p>
                )}
              </>
            )}
            {tracks && target && (
              <>
                <h3 className="mv-h">Sound and subtitles</h3>
                <TrackPicker tracks={tracks} value={picked} onChange={setPicked} is4k={(item.file?.video?.height ?? 0) > 1100} disabled={busy} native={target.tracksNative} {...(fit ? { direct: fit.direct } : {})} />
              </>
            )}
            {!tvs.length && item.playable && <p className="muted">No TV here can play videos yet.</p>}

            {item.children && item.children.length > 0 && (
              <div className="children">
                <h3 className="mv-h">{item.kind === "series" ? "Seasons" : item.kind === "season" ? "Episodes" : "In this collection"}</h3>
                {item.kind === "season" ? (
                  <ul className="episodes">
                    {item.children.map((c) => (
                      <li key={c.id}>
                        <button onClick={() => onOpen(c)}>
                          <span>{c.subtitle?.split(" · ")[0]}</span> <strong>{c.title}</strong> {c.played && <IconCheck size={14} />}
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

            {item.playable && (
              <div className="mv-actions">
                {target && (
                  <button className="primary big" disabled={busy || !target.online} onClick={() => void play(true)}>
                    <IconPlay size={18} /> {canResume ? `Resume on ${target.name} from ${clock(item.resumeSec!)}` : `${playLabel} on ${target.name}`}
                  </button>
                )}
                <div className="mv-two">
                  {target && canResume ? (
                    <button disabled={busy || !target.online} onClick={() => void play(false)}>
                      Start over
                    </button>
                  ) : (
                    <span />
                  )}
                  {single ? (
                    <button disabled={busy} onClick={() => void addToVote()}>
                      Add to a vote
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
                {target && item.resumeSec && single && !target.canSeek && (
                  <span className="muted small">
                    {target.name} starts from the beginning (its player can't pick up at {clock(item.resumeSec)}).
                  </span>
                )}
                {target?.now && (
                  <span className="muted small">
                    Replaces {target.now.title} on {target.name}.
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the page

function Browse({ onOpen, notify }: { onOpen: (c: Card) => void; notify: Notify }) {
  const [libs, setLibs] = useState<Library[] | null>(null);
  const [lib, setLib] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [resume, setResume] = useState<Card[]>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Card[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.libraries().then(
      (l) => (setLibs(l), setLib((cur) => cur || l[0]?.id || "")),
      (err: Error) => setError(err.message),
    );
    api.resume().then(setResume, () => undefined);
  }, []);
  useEffect(() => {
    if (!lib || lib === "resume") return;
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
  const searchTimer = useRef<number>();
  useEffect(() => {
    window.clearTimeout(searchTimer.current);
    if (q.trim().length < 2) return void setResults(null);
    searchTimer.current = window.setTimeout(() => api.search(q).then(setResults, (err: Error) => notify(err.message, true)), 300);
  }, [q, notify]);
  const list = results ?? (lib === "resume" ? resume : cards);

  return (
    <>
      <div className="mv-toolbar">
        <label className="mv-search">
          <IconSearch size={18} />
          <input type="search" placeholder="Search movies and shows" aria-label="Search movies and shows" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" />
        </label>
        {!results && libs && (
          <div className="mv-chips">
            {libs.map((l) => (
              <button key={l.id} aria-pressed={l.id === lib} className={l.id === lib ? "is-on" : ""} onClick={() => setLib(l.id)}>
                {l.title}
              </button>
            ))}
            {resume.length > 0 && (
              <button aria-pressed={lib === "resume"} className={lib === "resume" ? "is-on" : ""} onClick={() => setLib("resume")}>
                Carry on watching
              </button>
            )}
          </div>
        )}
      </div>
      {error && <p className="error pad">{error}</p>}
      {libs && !libs.length && <p className="muted pad">This Jellyfin user can't see any movie or TV libraries. Give it access to the movie library on the server.</p>}
      {results && !results.length && <p className="muted pad">Nothing found for “{q}”.</p>}
      <div className="grid mv-grid">
        {list.map((c) => (
          <Poster key={c.id} card={c} onOpen={onOpen} />
        ))}
      </div>
      {!results && lib !== "resume" && cards.length < total && (
        <div className="center pad">
          <button onClick={more}>Show more ({total - cards.length} left)</button>
        </div>
      )}
    </>
  );
}

function Banner({ state }: { state: StaffState }) {
  const p = state.video.problem;
  if (!state.ready)
    return (
      <p className="banner">
        No media server is connected, so there's nothing to browse or play from here. Tonight's list and the guest vote still work. <a href={bgUrl("/admin")}>Connect one in settings</a>
      </p>
    );
  if (p === "standalone") return <p className="banner">This copy isn't on a Bar Games box, so it can't play on TVs. Browsing still works.</p>;
  if (p === "box-too-old") return <p className="banner">This box can't hand videos to TVs yet: it needs a box update with video playback.</p>;
  if (state.video.fake) return <p className="banner dev">Dev mode: pretend TVs. Each play checks the stream link really works.</p>;
  if (!state.tvs.length) return <p className="banner">The box has no TVs that can play videos. Movies plays on Apple TVs and Rokus (box 0.27.0 or newer) and Venuebox apps (box 0.28.0 or newer).</p>;
  return null;
}

function Shell({ state, name, notify, reload, signOut }: { state: StaffState; name: string; notify: Notify; reload: () => Promise<void>; signOut: () => void }) {
  const layout = useLayout();
  const tvs = state.tvs;
  const [tvId, setTvState] = useState(readTv);
  const setTv = (id: string) => (setTvState(id), saveTv(id));
  // No TV remembered on this device: start on one that is playing.
  const selected = tvs.some((t) => t.displayId === tvId) ? tvId : ((tvs.find((t) => t.now) ?? tvs[0])?.displayId ?? "");
  const tv = tvs.find((t) => t.displayId === selected);
  // Links into the page: #remote, #vote, #item=<id>, #tv=<id> (the box can point staff here).
  const hash = useMemo(() => new URLSearchParams(location.hash.slice(1)), []);
  const [open, setOpen] = useState<string[]>(() => (hash.get("item") ? [hash.get("item")!] : []));
  const [voteOpen, setVoteOpen] = useState(() => hash.has("vote"));
  const [remoteOpen, setRemoteOpen] = useState(() => hash.has("remote"));
  useEffect(() => {
    const want = hash.get("tv");
    if (want) setTvState(want);
  }, [hash]);
  const openCard = (c: Card) => setOpen((o) => [...o, c.id]);
  const voteBusy = state.vote.open || !!state.vote.winner || state.vote.options.length > 0;

  return (
    <div className={`mv-shell is-${layout}`}>
      <div className="mv-main">
        <header className="mv-head">
          <h1>{name}</h1>
          <span className="mv-head-space" />
          <button className={`mv-headbtn${voteBusy ? " is-on" : ""}`} onClick={() => setVoteOpen(true)}>
            <IconVote size={18} /> <span>Guest vote{state.vote.open ? ` (${state.vote.total})` : ""}</span>
          </button>
          <a className="mv-headbtn is-icon" href={bgUrl("/admin")} aria-label="Settings">
            <IconGear />
          </a>
          <button className="link small" onClick={signOut}>
            Sign out
          </button>
        </header>
        <Banner state={state} />
        {state.ready && <Browse onOpen={openCard} notify={notify} />}
        <Tonight state={state} notify={notify} reload={reload} />
        <p className="muted small pad">
          Guests see what's on and vote on <a href={bgUrl("/")}>the guest page</a>.
        </p>
      </div>

      {tvs.length > 0 && layout === "landscape" && (
        <aside className="mv-side">
          <TvTabs tvs={tvs} selected={selected} onSelect={setTv} />
          {tv && <Remote tv={tv} vote={state.vote} variant="panel" notify={notify} reload={reload} />}
          <span className="mv-side-space" />
          <VoteSummary vote={state.vote} tvs={tvs} onOpen={() => setVoteOpen(true)} notify={notify} reload={reload} />
        </aside>
      )}
      {tvs.length > 0 && layout === "portrait" && (
        <aside className="mv-dock">
          <TvTabs tvs={tvs} selected={selected} onSelect={setTv} detail />
          {tv && <Remote tv={tv} vote={state.vote} variant="dock" notify={notify} reload={reload} />}
        </aside>
      )}
      {tv && layout === "phone" && <MiniBar tv={tv} onOpen={() => setRemoteOpen(true)} notify={notify} reload={reload} />}
      {tv && layout === "phone" && remoteOpen && (
        <div className="mv-fullremote" role="dialog" aria-modal="true" aria-label="Remote">
          <div className="mv-fullremote-head">
            <button className="mv-icon" onClick={() => setRemoteOpen(false)} aria-label="Back to browsing">
              <IconDown size={22} />
            </button>
            <span className="muted">Remote</span>
            <span className="mv-icon" />
          </div>
          <TvTabs tvs={tvs} selected={selected} onSelect={setTv} />
          <Remote tv={tv} vote={state.vote} variant="full" notify={notify} reload={reload} />
        </div>
      )}

      {open.length > 0 && <Details id={open[open.length - 1]!} tvs={tvs} tv={selected} onTv={setTv} onOpen={openCard} onClose={() => setOpen((o) => o.slice(0, -1))} notify={notify} reload={reload} phone={layout === "phone"} />}
      {voteOpen && <VoteSheet state={state} selectedTv={selected} onClose={() => setVoteOpen(false)} notify={notify} reload={reload} />}
    </div>
  );
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
        {notice && (
          <div className={`notice mv-notice${notice.error ? " is-error" : ""}`} role="status">
            <span>{notice.text}</span>
            <button className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
              <IconX size={16} />
            </button>
          </div>
        )}
        {!state ? <p className="muted center-page">Loading…</p> : <Shell state={state} name={name} notify={notify} reload={reload} signOut={() => void signOut()} />}
      </AuthGate>
    </div>
  );
}
