// Track ids for players that switch tracks themselves (SDK 0.19.0 `tracks`): the media
// server's stream index with a letter for its kind, so "a2" is audio stream 2, "s4" subtitle
// stream 4. The same ids come back in videoStatus and from the TV's own remote.

export const audioTrackId = (index: number): string => `a${index}`;
export const subtitleTrackId = (index: number): string => `s${index}`;

/** The stream index in a track id of this kind ("a2" → 2), or undefined. */
export function trackIndexOf(id: unknown, kind: "audio" | "subtitle"): number | undefined {
  if (typeof id !== "string") return undefined;
  const m = /^([as])(\d{1,4})$/.exec(id);
  if (!m || m[1] !== (kind === "audio" ? "a" : "s")) return undefined;
  return Number(m[2]);
}
