/**
 * Weather adapter — live by default.
 *
 * Open-Meteo needs no API key, which makes it the one integration Xana can run
 * for real out of the box. Location resolves from, in order:
 *   XANA_LAT/XANA_LON -> XANA_LOCATION (geocoded) -> IP geolocation -> a
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
  const lat = cred("XANA_LAT");
  const lon = cred("XANA_LON");
  if (lat.present && lon.present) {
    return {
      lat: Number(lat.value),
      lon: Number(lon.value),
      label: cred("XANA_LOCATION_LABEL").value || "Home",
    };
  }

  const name = cred("XANA_LOCATION");
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

  try {
    const ip = await httpJson<{ latitude?: number; longitude?: number; city?: string }>(
      "https://ipapi.co/json/",
      { timeoutMs: 4000 },
    );
    if (typeof ip.latitude === "number" && typeof ip.longitude === "number") {
      return { lat: ip.latitude, lon: ip.longitude, label: ip.city ?? "Your area" };
    }
  } catch {
    /* no location available */
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
          status: status(
            "weather", "Weather", "offline", "synthetic",
            "Set XANA_LAT/XANA_LON or XANA_LOCATION", Date.now() - t0,
          ),
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
          status: status("weather", "Weather", "error", "synthetic", errorMessage(err), Date.now() - t0),
        };
      }
    },
  });
}

export type { GeoResult };
