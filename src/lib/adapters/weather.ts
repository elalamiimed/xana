/**
 * Weather adapter — live by default, once it is allowed to be.
 *
 * Open-Meteo needs no API key, which makes it the one integration Xana can run
 * for real out of the box. It is still gated: the plugin declares `net.read`
 * and `location`, and this adapter is never constructed until both are granted,
 * so the IP geolocation below cannot happen behind the user's back.
 *
 * Location resolves from, in order:
 *   the coordinates you set -> a place name (geocoded) -> IP geolocation -> a
 *   clearly-labelled synthetic fallback.
 */

import type { WeatherSnapshot } from "../core/types";
import {
  cred,
  defineAdapter,
  errorMessage,
  httpJson,
  status,
  type LifeAdapter,
} from "./types";

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    precipitation_probability?: number;
  };
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    sunrise?: string[];
    sunset?: string[];
    precipitation_probability_max?: number[];
    weather_code?: number[];
  };
}

/** WMO weather interpretation codes, trimmed to the phrases Xana would use. */
const WMO: Record<number, string> = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers",
  85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm",
};

function describeCode(code: number | undefined): string {
  if (code === undefined) return "unknown";
  return WMO[code] ?? "changeable";
}

/** Round an ISO-ish local time from Open-Meteo ("2024-05-17T05:42") to HH:MM. */
function clockOf(value: string | undefined): string {
  if (!value) return "--:--";
  const t = value.split("T")[1];
  return t ? t.slice(0, 5) : value;
}

function synthetic(reason: string): WeatherSnapshot {
  return {
    location: "Unknown",
    temperatureC: 18,
    feelsLikeC: 18,
    condition: "unavailable",
    precipitationChance: 0,
    highC: 21,
    lowC: 12,
    sunrise: "06:30",
    sunset: "20:15",
    source: `synthetic (${reason})`,
    synthetic: true,
  };
}

interface GeoResult { lat: number; lon: number; label: string }

async function resolvePlace(): Promise<GeoResult | undefined> {
  // The plugin's own keys first, then the flat `XANA_*` names this feature used
  // before plugins existed. Both are read because both are legitimate — the
  // panel writes the qualified one, an exported variable is the old one — and
  // reading only the qualified key is the bug this comment replaces: a place
  // name saved in the panel did nothing, and the adapter fell through to IP
  // geolocation instead, which is the one path the user was trying to avoid by
  // naming their city.
  const lat = cred("weather.latitude", "XANA_LAT");
  const lon = cred("weather.longitude", "XANA_LON");
  if (lat.present && lon.present) {
    return {
      lat: Number(lat.value),
      lon: Number(lon.value),
      label: cred("weather.place", "XANA_LOCATION_LABEL").value || "Home",
    };
  }

  const name = cred("weather.place", "XANA_LOCATION", "XANA_LOCATION_LABEL");
  if (name.present) {
    try {
      const geo = await httpJson<{
        results?: Array<{ latitude: number; longitude: number; name: string; country_code?: string }>;
      }>(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name.value)}&count=1&language=en&format=json`,
        { timeoutMs: 5000 },
      );
      const hit = geo.results?.[0];
      if (hit) return { lat: hit.latitude, lon: hit.longitude, label: hit.name };
    } catch {
      /* fall through to IP lookup */
    }
  }

  /**
   * The IP lookup is the last resort, and it used to be a dead end.
   *
   * It asked `ipapi.co`, which now answers every request with a Cloudflare
   * challenge page — HTTP 403, `<!DOCTYPE html>… Just a moment…` — so a fresh
   * install that granted `net.read` and `location` and set no coordinates got
   * "Synthetic — set a latitude and longitude" and no forecast, with nothing in
   * the status row to explain that the *provider* had stopped serving. Two
   * hosts are tried instead, and both are keyless and HTTPS:
   *
   *   ipwho.is        latitude/longitude/city, 1,000 lookups a day
   *   freeipapi.com   the same fields under different names, as the fallback
   *
   * One lookup every fifteen minutes at most — the adapter's own TTL — is
   * nowhere near either limit, and the second host exists because a single
   * unauthenticated endpoint that can start refusing traffic is exactly the
   * fragility this path already demonstrated. A failure of both is reported by
   * the caller as "no location", which is honest: nothing was found, as opposed
   * to "the weather service is down".
   */
  const providers: Array<() => Promise<GeoResult | undefined>> = [
    async () => {
      const ip = await httpJson<{
        success?: boolean;
        latitude?: number;
        longitude?: number;
        city?: string;
      }>("https://ipwho.is/", { timeoutMs: 4000 });
      // `success: false` arrives with HTTP 200 for a reserved or malformed IP,
      // so the body is checked rather than only the status.
      if (ip.success === false) return undefined;
      if (typeof ip.latitude === "number" && typeof ip.longitude === "number") {
        return { lat: ip.latitude, lon: ip.longitude, label: ip.city ?? "Your area" };
      }
      return undefined;
    },
    async () => {
      const ip = await httpJson<{
        latitude?: number;
        longitude?: number;
        cityName?: string;
      }>("https://freeipapi.com/api/json", { timeoutMs: 4000 });
      if (typeof ip.latitude === "number" && typeof ip.longitude === "number") {
        return { lat: ip.latitude, lon: ip.longitude, label: ip.cityName ?? "Your area" };
      }
      return undefined;
    },
  ];

  for (const provider of providers) {
    try {
      const found = await provider();
      if (found) return found;
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

export function weatherAdapter(): LifeAdapter {
  return defineAdapter<{ weather: WeatherSnapshot }>({
    id: "weather",
    label: "Weather",
    ttlMs: 15 * 60_000,
    empty: { weather: synthetic("no location") },
    async produce() {
      const t0 = Date.now();
      const place = await resolvePlace();
      if (!place) {
        return {
          data: { weather: synthetic("no location") },
          status: {
            ...status(
              "weather", "Weather", "offline", "synthetic",
              "Set a latitude and longitude, or a place name", Date.now() - t0,
            ),
            synthetic: true,
          },
        };
      }

      try {
        const url =
          `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
          `&current=temperature_2m,apparent_temperature,weather_code,precipitation_probability` +
          `&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,weather_code` +
          `&forecast_days=1&timezone=auto`;
        const data = await httpJson<OpenMeteoResponse>(url, { timeoutMs: 5000 });

        const snapshot: WeatherSnapshot = {
          location: place.label,
          temperatureC: Math.round(data.current?.temperature_2m ?? 0),
          feelsLikeC: Math.round(data.current?.apparent_temperature ?? data.current?.temperature_2m ?? 0),
          condition: describeCode(data.current?.weather_code ?? data.daily?.weather_code?.[0]),
          precipitationChance:
            (data.current?.precipitation_probability ?? data.daily?.precipitation_probability_max?.[0] ?? 0) / 100,
          highC: Math.round(data.daily?.temperature_2m_max?.[0] ?? 0),
          lowC: Math.round(data.daily?.temperature_2m_min?.[0] ?? 0),
          sunrise: clockOf(data.daily?.sunrise?.[0]),
          sunset: clockOf(data.daily?.sunset?.[0]),
          source: "open-meteo",
        };
        return {
          data: { weather: snapshot },
          status: status("weather", "Weather", "connected", "live", place.label, Date.now() - t0),
        };
      } catch (err) {
        return {
          data: { weather: synthetic(errorMessage(err)) },
          status: {
            // `synthetic: true` because the numbers in the snapshot above are
            // invented. The plugin layer shows this as "synthetic" rather than
            // "cached", which is the honest distinction: a forecast that could
            // not be fetched is not a forecast we have an old copy of.
            ...status("weather", "Weather", "error", "synthetic", errorMessage(err), Date.now() - t0),
            synthetic: true,
          },
        };
      }
    },
  });
}

export type { GeoResult };
