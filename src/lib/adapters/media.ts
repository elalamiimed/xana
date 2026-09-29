/**
 * Media adapter — what you're listening to, and what you should listen to.
 *
 * Spotify's Web API needs OAuth, but "now playing" is available from any local
 * player that exposes itself, so Xana supports two keyless paths:
 *
 *  - `XANA_NOWPLAYING_URL` — any local endpoint returning JSON with a track
 *    name (works with the many Spotify/foobar/mpv web bridges).
 *  - `XANA_NOWPLAYING_FILE` — a text or JSON file a script keeps up to date.
 *
 * When nothing is playing, Xana still offers a focus suggestion matched to the
 * day's energy band, because that is genuinely useful context for a work block.
 */

import { readFileSync } from "node:fs";
import type { AdapterStatus, EnergyBand, MediaContext } from "../core/types";
import { cred, defineAdapter, errorMessage, httpJson, status, type LifeAdapter } from "./types";

/** Focus pairings by energy band. Returns a short, human suggestion. */
export function focusSuggestionFor(band: EnergyBand): string {
  switch (band) {
    case "peak":
      return "long-form ambient, nothing with lyrics";
    case "sharp":
      return "instrumental post-rock or a steady 90bpm pulse";
    case "steady":
      return "lo-fi or a familiar album you won't skip through";
    case "low":
      return "something warm and slow — protect the little energy you have";
  }
}

function fromNowPlaying(raw: Record<string, unknown>): MediaContext | undefined {
  // Tolerate common wrappers: {item:{name}}, {track:{title}}, {data:{...}}
  const nested = ["item", "track", "song", "nowPlaying", "data", "current"]
    .map((k) => raw[k])
    .find((v) => v && typeof v === "object") as Record<string, unknown> | undefined;
  const src = nested ? { ...nested, ...raw } : raw;

  const name =
    (typeof src.name === "string" && src.name) ||
    (typeof src.title === "string" && src.title) ||
    (typeof src.track === "string" && src.track) ||
    undefined;
  if (!name) return undefined;

  const artist =
    (typeof src.artist === "string" && src.artist) ||
    (typeof src.artistName === "string" && src.artistName) ||
    (Array.isArray(src.artists) && typeof src.artists[0] === "string" ? src.artists[0] : undefined) ||
    (Array.isArray(src.artists) &&
    src.artists[0] && typeof src.artists[0] === "object" &&
    typeof (src.artists[0] as Record<string, unknown>).name === "string"
      ? String((src.artists[0] as Record<string, unknown>).name)
      : undefined) ||
    undefined;

  return {
    nowPlaying: name,
    artist: artist || undefined,
    source: "local-bridge",
  };
}

export function mediaAdapter(band: () => EnergyBand = () => "steady"): LifeAdapter {
  const url = cred("XANA_NOWPLAYING_URL");
  const file = cred("XANA_NOWPLAYING_FILE");
  const configured = url.present || file.present;
  const id = "media";

  const read = async (): Promise<{ data: { media: MediaContext }; status: AdapterStatus }> => {
    const t0 = Date.now();
    const suggestion = focusSuggestionFor(band());

    if (!configured) {
      return {
        data: { media: { focusSuggestion: suggestion, source: "local" } },
        status: status(
          id, "Media", "local", "local",
          "set XANA_NOWPLAYING_URL or XANA_NOWPLAYING_FILE for now-playing",
          Date.now() - t0,
        ),
      };
    }

    try {
      let parsed: Record<string, unknown> | undefined;
      if (url.present) {
        parsed = await httpJson<Record<string, unknown>>(url.value, { timeoutMs: 2500 });
      } else if (file.present) {
        const text = readFileSync(file.value, "utf8").trim();
        parsed = text.startsWith("{")
          ? (JSON.parse(text) as Record<string, unknown>)
          : { name: text.split("\n")[0] };
      }

      const live = parsed ? fromNowPlaying(parsed) : undefined;
      const media: MediaContext = live
        ? { ...live, focusSuggestion: suggestion }
        : { focusSuggestion: suggestion, source: "local" };
      return {
        data: { media },
        status: status(
          id, "Media", live ? "connected" : "local", live ? "live" : "local",
          live ? `playing: ${live.nowPlaying}` : "nothing playing",
          Date.now() - t0,
        ),
      };
    } catch (err) {
      return {
        data: { media: { focusSuggestion: suggestion, source: "local" } },
        status: status(id, "Media", "error", "local", errorMessage(err), Date.now() - t0),
      };
    }
  };

  return defineAdapter<{ media: MediaContext }>({
    id,
    label: "Media",
    ttlMs: 20_000,
    empty: { media: { source: "local" } },
    produce: read,
  });
}
