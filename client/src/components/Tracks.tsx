// Audio track and subtitles: picked before a movie starts (the details sheet) and changed while
// it plays (the dock). The TVs' own players can't switch tracks, so anything but the file's
// default audio and no subtitles goes through the server: another audio track is repackaged
// (the picture untouched), and subtitles are burned into the picture.

import type { Track, TrackChoice, Tracks } from "@movies/shared";

export interface Picked {
  audio?: number;
  /** null: no subtitles. */
  sub: number | null;
}

export const defaults = (t?: Tracks): Picked => ({ ...(t?.defaultAudio != null ? { audio: t.defaultAudio } : {}), sub: null });

/** Worth showing: more than one audio track, or any subtitles. */
export const hasChoices = (t?: Tracks): t is Tracks => !!t && (t.audio.length > 1 || t.subtitles.length > 0);

export const isDefault = (t: Tracks | undefined, p: Picked) => p.sub == null && (p.audio == null || p.audio === t?.defaultAudio);

/** For the API: only what differs from the defaults. */
export function toChoice(t: Tracks | undefined, p: Picked): TrackChoice {
  return { ...(p.audio != null && p.audio !== t?.defaultAudio ? { audioIndex: p.audio } : {}), subtitleIndex: p.sub };
}

const audioName = (a: Track) => `${a.label}${a.default ? " (default)" : ""}`;
const subName = (s: Track) => `${s.label}${s.forced ? " · forced (foreign parts only)" : ""}${s.external ? " · separate file" : ""}`;

export function trackWords(t: Tracks | undefined, audio?: number, sub?: number | null): string {
  if (!t) return "";
  const parts: string[] = [];
  const a = t.audio.find((x) => x.index === audio);
  if (a && t.audio.length > 1) parts.push(`Audio: ${a.label}`);
  const s = sub != null ? t.subtitles.find((x) => x.index === sub) : undefined;
  if (s) parts.push(`Subtitles: ${s.label}`);
  return parts.join(" · ");
}

export function TrackPicker({ tracks, value, onChange, is4k, disabled }: { tracks: Tracks; value: Picked; onChange: (p: Picked) => void; is4k?: boolean; disabled?: boolean }) {
  const otherAudio = value.audio != null && value.audio !== tracks.defaultAudio;
  return (
    <div className="tracks">
      <div className="tracks-row">
        {tracks.audio.length > 0 && (
          <label>
            <span className="label">Audio</span>
            <select disabled={disabled || tracks.audio.length < 2} value={value.audio ?? ""} onChange={(e) => onChange({ ...value, audio: Number(e.target.value) })}>
              {tracks.audio.map((a) => (
                <option key={a.index} value={a.index}>
                  {audioName(a)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span className="label">Subtitles</span>
          <select disabled={disabled || !tracks.subtitles.length} value={value.sub ?? "off"} onChange={(e) => onChange({ ...value, sub: e.target.value === "off" ? null : Number(e.target.value) })}>
            <option value="off">{tracks.subtitles.length ? "Off" : "None in this file"}</option>
            {tracks.subtitles.map((s) => (
              <option key={s.index} value={s.index}>
                {subName(s)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {otherAudio && value.sub == null && <p className="tracks-note">Another audio track: the server repackages the movie with it. The picture isn't changed.</p>}
      {value.sub != null && (
        <p className="tracks-note warn">
          Subtitles are burned into the picture: the server converts the whole picture, which is the heaviest work it does, and the quality drops slightly.
          {is4k ? " A 4K movie may be more than the server can keep up with: if it stutters, turn subtitles off." : ""}
        </p>
      )}
    </div>
  );
}
