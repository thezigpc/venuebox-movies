// The guest page (bargames.json routes.player "/"): what's on the TVs, what staff say is on
// tonight, and the vote for the next movie. No sign-in. It never plays anything: that's staff's.

import { useCallback, useEffect, useRef, useState } from "react";
import { VenueAnnouncement } from "@bargames/gamekit/client";
import { bgUrl } from "@bargames/sdk/client";
import { clock, runtime, type PublicState } from "@movies/shared";
import { api, img } from "../api";
import { IconCheck } from "../components/Icons";
import { useVenue } from "../useVenue";

const VOTER_KEY = "movies.voter";
/** This browser's vote id: one vote per round, changeable. Not tied to a person. */
function voterId(): string {
  const make = () => {
    const b = new Uint8Array(18);
    crypto.getRandomValues(b);
    return "v-" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  };
  try {
    const have = localStorage.getItem(VOTER_KEY);
    if (have && /^[A-Za-z0-9_-]{16,64}$/.test(have)) return have;
    const id = make();
    localStorage.setItem(VOTER_KEY, id);
    return id;
  } catch {
    return make();
  }
}

const endsAt = (sec: number) => new Date(Date.now() + sec * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function GuestPage() {
  const venue = useVenue();
  const voter = useRef(voterId()).current;
  const [state, setState] = useState<PublicState | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.publicState(voter);
      setState(s);
      setLeft(s.vote?.closesInSec ?? null);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [voter]);
  useEffect(() => {
    void load();
    const t = setInterval(() => !document.hidden && void load(), 4000);
    return () => clearInterval(t);
  }, [load]);
  // The countdown ticks between loads.
  useEffect(() => {
    const t = setInterval(() => setLeft((x) => (x == null ? x : Math.max(0, x - 1))), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    document.title = state?.name ?? "Movies";
  }, [state?.name]);

  const cast = async (itemId: string) => {
    setBusy(true);
    setError("");
    try {
      setState(await api.publicVote(voter, itemId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That vote didn't go through.");
      void load();
    } finally {
      setBusy(false);
    }
  };

  const vote = state?.vote ?? null;
  const onNow = state?.tonight.filter((e) => e.onNow) ?? [];
  const later = state?.tonight.filter((e) => !e.onNow) ?? [];
  const nothingOn = state && !state.playing.length && !onNow.length;
  const most = Math.max(1, ...(vote?.options.map((o) => o.votes) ?? [1]));

  return (
    <div className="guest">
      <VenueAnnouncement ctx={venue} />
      <header className="guest-head">
        {venue?.venue?.name ? <span className="muted small">{venue.venue.name}</span> : null}
        <h1>{state?.name ?? "Movies"}</h1>
      </header>
      {state?.staff && (
        <div className="guest-staff">
          <span className="small">You're signed in to the box as staff. This is the page guests see.</span>
          <div className="mv-two">
            <a className="button primary" href={bgUrl("/staff")}>
              Staff controls
            </a>
            <a className="button" href={bgUrl("/admin")}>
              Settings
            </a>
          </div>
        </div>
      )}
      {!state && !offline && <p className="muted pad">Loading…</p>}
      {offline && <p className="error pad">Can't reach the app right now. It will try again by itself.</p>}

      {state && (
        <main className="guest-main">
          <section>
            <h2 className="mv-h">On now</h2>
            {nothingOn && <p className="muted">Nothing is playing right now.</p>}
            {state.playing.map((p, i) => (
              <div key={`${p.tv}-${i}`} className="g-now">
                {p.poster ? <img className="g-now-poster" src={img(p.poster)} alt="" /> : <span className="g-now-poster blank" />}
                <div className="g-now-text">
                  <span className="g-tv">{p.tv}</span>
                  <strong>{p.title}</strong>
                  {p.subtitle && <span className="muted small">{p.subtitle}</span>}
                  {p.progress != null && (
                    <span className="mv-bar">
                      <span style={{ width: `${Math.round(p.progress * 100)}%` }} />
                    </span>
                  )}
                  <span className="muted small">{p.paused ? "Paused" : p.endsInSec != null ? `Ends about ${endsAt(p.endsInSec)}` : "Playing"}</span>
                </div>
              </div>
            ))}
            {onNow.map((e) => (
              <div key={e.id} className="g-row">
                <span className="g-row-text">
                  <strong>{e.title}</strong>
                  {e.when && <span className="muted small">{e.when}</span>}
                </span>
                <span className="g-tv">On now</span>
              </div>
            ))}
          </section>

          {later.length > 0 && (
            <section>
              <h2 className="mv-h">Playing tonight</h2>
              {later.map((e) => (
                <div key={e.id} className="g-row">
                  <span className="g-row-text">
                    <strong>{e.title}</strong>
                  </span>
                  {e.when && <span className="muted small">{e.when}</span>}
                </div>
              ))}
            </section>
          )}

          {vote?.open && (
            <section>
              <div className="g-vote-head">
                <h2 className="mv-h">Vote: next{vote.tvName ? ` on ${vote.tvName}` : " movie"}</h2>
                {left != null && <span className="g-closes">Closes in {clock(left)}</span>}
              </div>
              {vote.options.map((o) => {
                const mine = vote.yourVote === o.itemId;
                return (
                  <div key={o.itemId} className={`g-opt${mine ? " is-mine" : ""}`}>
                    <span className="g-opt-fill" style={{ width: `${Math.round((o.votes / most) * 100)}%`, opacity: o.votes ? 0.14 : 0 }} />
                    {o.poster ? <img className="g-opt-poster" src={img(o.poster)} alt="" /> : <span className="g-opt-poster blank">{o.title.slice(0, 1)}</span>}
                    <span className="g-opt-text">
                      <strong>{o.title}</strong>
                      {(o.year || o.runtimeSec) && <span className="muted small">{[o.year, o.runtimeSec ? runtime(o.runtimeSec) : ""].filter(Boolean).join(" · ")}</span>}
                      <span className="small">{o.votes === 0 ? "No votes yet" : o.votes === 1 ? "1 vote" : `${o.votes} votes`}</span>
                    </span>
                    {mine ? (
                      <span className="g-mine">
                        <IconCheck size={14} /> Your vote
                      </span>
                    ) : (
                      <button className="g-vote-btn" disabled={busy} onClick={() => void cast(o.itemId)}>
                        Vote
                      </button>
                    )}
                  </div>
                );
              })}
              {error && <p className="error small">{error}</p>}
              <p className="muted small">
                One vote each. You can change it until the vote closes.
                {vote.closes === "movie-end" ? " It closes when the current movie ends." : ""}
              </p>
            </section>
          )}
          {vote && !vote.open && vote.winner && (
            <section>
              <h2 className="mv-h">The vote is in</h2>
              <div className="g-row is-winner">
                <span className="g-row-text">
                  <strong>{vote.winner.title}</strong>
                  <span className="muted small">
                    Won with {vote.winner.votes === 1 ? "1 vote" : `${vote.winner.votes} votes`}
                    {vote.tvName && !vote.winner.manual ? `. Up next on ${vote.tvName}.` : ". Coming up."}
                  </span>
                </span>
              </div>
            </section>
          )}
        </main>
      )}
      <footer className="guest-foot muted small">
        The staff choose what plays. <a href={bgUrl("/staff")}>Staff sign-in</a>
      </footer>
    </div>
  );
}
