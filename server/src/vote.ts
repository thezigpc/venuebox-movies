// The guest vote: staff pick a few movies, guests vote on the public page, and the winner goes
// on a TV. One vote at a time, kept in memory (an app restart ends it). Guests are counted by
// an id their browser keeps, with a cap per network address so one phone can't flood it.

import type { ItemDetail, VoteCloses, VoteOption, VotePublic, VoteStaff } from "@movies/shared";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

export class VoteError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export interface VoteDeps {
  now?: () => number;
  /** The TV's name, or undefined when the box doesn't list it. */
  tvName(displayId: string): string | undefined;
  /** Something is on that TV right now. */
  isPlaying(displayId: string): boolean;
  play(displayId: string, itemId: string): Promise<unknown>;
}

export const MAX_OPTIONS = 8;
const MAX_VOTERS = 5000;
const MAX_PER_ADDRESS = 6;
const VOTER_ID = /^[A-Za-z0-9_-]{16,64}$/;

export class Vote {
  private options: VoteOption[] = [];
  private open = false;
  private displayId: string | undefined;
  private closes: VoteCloses = "manual";
  private closesAt: number | undefined;
  private autoPlay = true;
  private votes = new Map<string, string>();
  private perAddress = new Map<string, Set<string>>();
  /** The winner of the last round, waiting to go on (or for staff to start it). */
  private winner: { itemId: string; title: string; displayId?: string; votes: number; manual?: boolean } | undefined;
  private note: string | undefined;
  private readonly now: () => number;

  constructor(private readonly d: VoteDeps) {
    this.now = d.now ?? Date.now;
  }

  // ---------------------------------------------------------------- staff

  add(item: Pick<ItemDetail, "id" | "kind" | "title" | "year" | "runtimeSec" | "poster">): void {
    if (this.open) throw new VoteError("The vote is open: close it before changing the movies.");
    if (item.kind !== "movie" && item.kind !== "episode") throw new VoteError("Only a movie or an episode can go in a vote.", 400);
    if (this.options.some((o) => o.itemId === item.id)) return;
    if (this.options.length >= MAX_OPTIONS) throw new VoteError(`A vote takes up to ${MAX_OPTIONS} movies.`, 400);
    this.options.push({ itemId: item.id, title: item.title, ...(item.year ? { year: item.year } : {}), ...(item.runtimeSec ? { runtimeSec: item.runtimeSec } : {}), ...(item.poster ? { poster: item.poster } : {}) });
  }

  /** A movie staff typed in (no media server): guests can vote for it, staff put it on. */
  addManual(title: string): void {
    if (this.open) throw new VoteError("The vote is open: close it before changing the movies.");
    const t = title.trim().slice(0, 120);
    if (!t) throw new VoteError("Type the movie's name.", 400);
    if (this.options.some((o) => o.title.toLowerCase() === t.toLowerCase())) return;
    if (this.options.length >= MAX_OPTIONS) throw new VoteError(`A vote takes up to ${MAX_OPTIONS} movies.`, 400);
    this.options.push({ itemId: `manual-${randomUUID()}`, title: t, manual: true });
  }

  remove(itemId: string): void {
    if (this.open) throw new VoteError("The vote is open: close it before changing the movies.");
    this.options = this.options.filter((o) => o.itemId !== itemId);
  }

  /** displayId: the TV the winner plays on. Without one, the winner is only announced. */
  start(o: { displayId?: string; closes: VoteCloses; minutes?: number; autoPlay: boolean }): void {
    if (this.open) throw new VoteError("The vote is already open.");
    if (this.options.length < 2) throw new VoteError("Add at least two movies first.", 400);
    if (o.displayId && !this.d.tvName(o.displayId)) throw new VoteError("The box doesn't list that TV.", 400);
    if (o.closes === "movie-end" && !o.displayId) throw new VoteError("Pick the TV whose movie ends the vote.", 400);
    const minutes = Math.min(240, Math.max(1, Math.round(o.minutes ?? 10)));
    this.displayId = o.displayId || undefined;
    this.closes = o.closes;
    this.closesAt = o.closes === "time" ? this.now() + minutes * 60_000 : undefined;
    this.autoPlay = o.autoPlay;
    this.votes.clear();
    this.perAddress.clear();
    this.winner = undefined;
    this.note = undefined;
    this.open = true;
    log.info("vote", "opened", { tv: o.displayId ? this.d.tvName(o.displayId) : undefined, movies: this.options.length, closes: o.closes, autoPlay: o.autoPlay });
  }

  /** Closes the vote and settles the winner. finished: the TV's movie just ended by itself. */
  async close(finished = false): Promise<void> {
    if (!this.open) throw new VoteError("No vote is open.");
    this.open = false;
    this.closesAt = undefined;
    const tally = this.tally();
    const best = this.options.map((o) => ({ o, n: tally.get(o.itemId) ?? 0 })).sort((a, b) => b.n - a.n)[0];
    const displayId = this.displayId;
    if (!best || best.n === 0) {
      this.note = "Nobody voted, so nothing was picked.";
      log.info("vote", "closed with no votes");
      return;
    }
    const playable = !best.o.manual && !!displayId;
    this.winner = { itemId: best.o.itemId, title: best.o.title, votes: best.n, ...(playable ? { displayId } : {}), ...(best.o.manual ? { manual: true } : {}) };
    this.options = [];
    log.info("vote", "closed", { winner: best.o.title, votes: best.n });
    // A typed-in movie, or no TV chosen: the winner is announced, and staff put it on.
    if (!playable) return void (this.note = `"${best.o.title}" won. It isn't on the media server, so put it on yourself.`);
    if (this.autoPlay && (finished || !this.d.isPlaying(displayId!))) await this.playWinner().catch(() => undefined);
  }

  /** Starts the winner now (staff's "Play now", or by itself when the TV is free). */
  async playWinner(): Promise<void> {
    const w = this.winner;
    if (!w) throw new VoteError("There's no winner waiting.");
    if (!w.displayId) throw new VoteError("That winner can't start by itself: it isn't on the media server.");
    try {
      await this.d.play(w.displayId, w.itemId);
      this.winner = undefined;
      this.note = undefined;
    } catch (err) {
      this.note = `The winner didn't start: ${err instanceof Error ? err.message : String(err)}`;
      log.warn("vote", "the winner didn't start", { title: w.title, err: String(err) });
      throw err;
    }
  }

  /** Throws everything away: the movies, the votes and a waiting winner. */
  clear(): void {
    this.options = [];
    this.open = false;
    this.closesAt = undefined;
    this.votes.clear();
    this.perAddress.clear();
    this.winner = undefined;
    this.note = undefined;
  }

  // ---------------------------------------------------------------- timing

  /** Called regularly: closes a timed vote. */
  async tick(): Promise<void> {
    if (this.open && this.closes === "time" && this.closesAt != null && this.now() >= this.closesAt) await this.close().catch((err) => log.warn("vote", "closing failed", { err: String(err) }));
  }

  /** A TV's movie (or queue) ended by itself. */
  async finished(displayId: string): Promise<void> {
    if (this.open && this.closes === "movie-end" && this.displayId === displayId) return void (await this.close(true).catch(() => undefined));
    if (this.winner && this.autoPlay && this.winner.displayId === displayId) await this.playWinner().catch(() => undefined);
  }

  // ---------------------------------------------------------------- guests

  cast(voter: unknown, itemId: unknown, address: string): void {
    if (!this.open) throw new VoteError("The vote is closed.");
    if (typeof voter !== "string" || !VOTER_ID.test(voter)) throw new VoteError("That vote didn't come through. Reload the page and try again.", 400);
    if (typeof itemId !== "string" || !this.options.some((o) => o.itemId === itemId)) throw new VoteError("That movie isn't in the vote.", 400);
    if (!this.votes.has(voter)) {
      if (this.votes.size >= MAX_VOTERS) throw new VoteError("The vote is full.", 429);
      const ids = this.perAddress.get(address) ?? new Set<string>();
      if (ids.size >= MAX_PER_ADDRESS) throw new VoteError("Too many votes from this connection already.", 429);
      ids.add(voter);
      this.perAddress.set(address, ids);
    }
    this.votes.set(voter, itemId);
  }

  // ---------------------------------------------------------------- views

  private tally(): Map<string, number> {
    const t = new Map<string, number>();
    for (const id of this.votes.values()) t.set(id, (t.get(id) ?? 0) + 1);
    return t;
  }

  private view(): Omit<VotePublic, "yourVote"> {
    const tally = this.tally();
    return {
      open: this.open,
      options: this.options.map((o) => ({ ...o, votes: tally.get(o.itemId) ?? 0 })),
      total: this.votes.size,
      ...(this.displayId && (this.open || this.winner) ? { tvName: this.d.tvName(this.displayId) ?? "the TV" } : {}),
      ...(this.open ? { closes: this.closes } : {}),
      ...(this.closesAt != null ? { closesInSec: Math.max(0, Math.round((this.closesAt - this.now()) / 1000)) } : {}),
      ...(this.winner ? { winner: { title: this.winner.title, votes: this.winner.votes, ...(this.winner.manual ? { manual: true } : {}) } } : {}),
    };
  }

  /** For guests: nothing while staff are still choosing the movies. */
  publicView(voter?: string): VotePublic | null {
    if (!this.open && !this.winner) return null;
    const mine = voter ? this.votes.get(voter) : undefined;
    return { ...this.view(), ...(mine ? { yourVote: mine } : {}) };
  }

  staffView(): VoteStaff {
    return {
      ...this.view(),
      autoPlay: this.autoPlay,
      ...(this.displayId ? { displayId: this.displayId } : {}),
      ...(this.winner?.displayId ? { winnerItemId: this.winner.itemId, winnerDisplayId: this.winner.displayId } : {}),
      ...(this.note ? { note: this.note } : {}),
    };
  }
}
