// One interface for every media server. Jellyfin is built (jellyfin.ts); Plex is next
// (plex.ts is a stub that says so). Everything above this line (the player, the box's media
// commands, the pages) only talks to MediaSource, never to a server's own API.

import type { Card, ItemDetail, Library, Page, TestResult, TrackChoice, TvProfile } from "@movies/shared";

export class SourceError extends Error {
  constructor(
    message: string,
    /** HTTP status for our own API: 401 sign in again, 404 gone, 409 can't, 502 server trouble. */
    readonly status = 502,
    readonly kind: "signed-out" | "not-found" | "unreachable" | "refused" | "cert" | "other" = "other",
  ) {
    super(message);
  }
}

export interface Playback {
  /** The link the TV opens. Carries the server's key: never log it, never put it in an event. */
  url: string;
  mime: string;
  /** The TV plays the file as it is (else the server's HLS transcode or remux). */
  directPlay: boolean;
  /** Where to start, seconds (a resume point). */
  startAt?: number;
  /** Why it isn't direct play, for the staff page ("container mkv"). */
  reasons: string[];
  /** For reporting back to the server (now playing, resume points). */
  session: PlaySession;
  /** The audio track it plays (a stream index), when the server says. */
  audioIndex?: number;
  /** The subtitle burned into the picture, or null for none. */
  subtitleIndex: number | null;
}

export interface PlaySession {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  method: "direct" | "transcode";
}

export interface ReportPosition {
  positionSec: number;
  paused?: boolean;
}

export interface MediaSource {
  readonly kind: "jellyfin" | "plex";
  /** The server answers and is the right kind: its name and version. No sign-in needed. */
  test(): Promise<TestResult>;
  libraries(): Promise<Library[]>;
  /** Collections (box sets) across every library: the box's media_list offers them. */
  collections(): Promise<Card[]>;
  browse(libraryId: string, page: number, pageSize?: number): Promise<Page<Card>>;
  search(q: string): Promise<Card[]>;
  item(id: string): Promise<ItemDetail>;
  /**
   * What playing this id means, as a list of playable ids: a movie or episode is itself; a
   * series is its episodes from the next one up; a season its episodes; a collection its
   * movies; a library a shuffle of it.
   */
  queue(id: string): Promise<{ ids: string[]; label: string }>;
  /** A stream link for one movie or episode, for this TV. */
  /**
   * A stream link for one movie or episode, for this TV. A chosen audio track (not the
   * default) or subtitle makes it the server's HLS: the audio is repackaged (the picture is
   * copied); a subtitle is burned into the picture (the whole picture is converted).
   */
  playback(id: string, tv: TvProfile, opts?: { startAt?: number } & TrackChoice): Promise<Playback>;
  /** The TV's poster image, as a link the TV can open (no key in it). */
  tvPosterUrl(id: string): string | undefined;
  /** A poster for the staff page, fetched by us (the page never talks to the server). */
  poster(id: string, width: number): Promise<{ contentType: string; body: Buffer } | null>;
  reportStart(s: PlaySession, p: ReportPosition): Promise<void>;
  reportProgress(s: PlaySession, p: ReportPosition): Promise<void>;
  reportStop(s: PlaySession, p: ReportPosition): Promise<void>;
}
