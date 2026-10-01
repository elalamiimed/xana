/**
 * Crypto adapter — coin quotes, read into the same signals the markets write.
 *
 * CoinGecko's `simple/price` endpoint needs no key and no account, which makes
 * crypto the one price source Xana can offer without asking anyone to paste a
 * token. It is still gated: the plugin declares `net.read` for
 * api.coingecko.com, so this adapter is never constructed until the user allows
 * that host.
 *
 * The lines go into the SAME `finance[]` slice `finance.ts` writes to, on
 * purpose. The briefing, the mind prompt and the ambient card already read that
 * slice, so a coin costs no new plumbing and no new wire shape — the two
 * sources stay distinguishable by label rather than by a second key the whole
 * app would have to learn.
 *
 *   XANA_CRYPTO_COINS="bitcoin, ethereum, solana"
 */

import type { AdapterStatus, FinanceSignal } from "../core/types";
import { cred, defineAdapter, hostOf, httpJson, reachFailure, status, type LifeAdapter } from "./types";

const DEFAULT_COINS = ["bitcoin", "ethereum", "solana"];

/**
 * Cap on the request.
 *
 * The free endpoint rate-limits by the minute, and a longer list is a longer
 * URL for no more value: the brief holds a handful of lines and would cut the
 * tail anyway. Eight is what one `simple/price` call carries comfortably.
 */
const MAX_COINS = 8;

/**
 * CoinGecko ids are lowercase slugs.
 *
 * The list comes from a settings field, so it is checked before it is pasted
 * into a query string and into a label: an id that does not look exactly like
 * an id never reaches the URL, which keeps a typo from becoming a request for
 * something that does not exist.
 */
const ID_SHAPE = /^[a-z0-9-]+$/;

/**
 * Names worth spelling out.
 *
 * The fallback below title-cases the id, which reads correctly for `bitcoin`
 * and `solana` and produces "Avalanche 2" and "Usd Coin" for the slugs those
 * coins actually use. The label is the whole line on the card, so the ids that
 * are not words are pinned here by hand.
 */
const NAMES: Record<string, string> = {
  bitcoin: "Bitcoin",
  ethereum: "Ethereum",
  solana: "Solana",
  "avalanche-2": "Avalanche",
  "usd-coin": "USDC",
  binancecoin: "BNB",
};

/** `avalanche-2` -> "Avalanche 2", `shiba-inu` -> "Shiba Inu". */
function pretty(id: string): string {
  const known = NAMES[id];
  if (known) return known;
  const words = id.split("-").filter((word) => word.length > 0);
  const label = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  return label.length > 0 ? label : id;
}

/**
 * A USD price, at the precision the number deserves.
 *
 * One fixed precision cannot serve all three bands: bitcoin trades at five
 * figures, ether at four, and the coins below a dollar in fractions of a cent
 * where two decimals would print `$0.00` and say nothing. So above a dollar the
 * format is money, and below it the format is significance. The trailing zeros
 * come off the small band because `toFixed` cannot know the price was `0.5`
 * rather than `0.500000`.
 */
function formatPrice(value: number): string {
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toFixed(2);
  const decimals = Math.min(20, Math.max(0, 5 - Math.floor(Math.log10(value))));
  const fixed = value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  // A price far below the twentieth decimal rounds to "0" above, and "$0" for
  // something that does have a price is worse than an exponent.
  return Number(fixed) === 0 ? value.toExponential(2) : fixed;
}

/**
 * The 24h move, signed.
 *
 * A change that rounds to zero is printed as `+0.00%` rather than `-0.00%`:
 * the minus reads as a fall, and a coin that barely moved is the flat thing it
 * is.
 */
function signedChange(change: number): string {
  const magnitude = Math.abs(change) < 0.005 ? "0.00" : Math.abs(change).toFixed(2);
  return `${change < 0 && magnitude !== "0.00" ? "-" : "+"}${magnitude}%`;
}

/** One coin's quote, before it is dressed as a `FinanceSignal`. */
export interface CoinQuote {
  /** CoinGecko id, e.g. "bitcoin". */
  id: string;
  /** Price in USD. */
  price: number;
  /** 24h change in percent, e.g. -1.2. */
  change: number;
}

/**
 * Read a `simple/price` body into rows, dropping anything unusable.
 *
 * The response is `{ "<id>": { "usd": 67000, "usd_24h_change": 2.4 }, … }` and
 * every field in it is optional as far as this parser is concerned. The
 * endpoint is public and unauthenticated, so a shape change, an error body or a
 * rate-limit document has to come out as "no rows" rather than as a `NaN` price
 * printed on the card. A row without a positive, finite price is not a quote; a
 * missing or retyped change is read as 0, which the trend then reports as flat
 * rather than inventing a direction.
 */
export function parseCoinGecko(json: unknown): CoinQuote[] {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return [];
  const rows: CoinQuote[] = [];
  for (const [id, value] of Object.entries(json as Record<string, unknown>)) {
    if (id.length === 0) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as { usd?: unknown; usd_24h_change?: unknown };
    const price = typeof entry.usd === "number" ? entry.usd : Number.NaN;
    if (!Number.isFinite(price) || price <= 0) continue;
    const change = typeof entry.usd_24h_change === "number" ? entry.usd_24h_change : 0;
    rows.push({ id, price, change: Number.isFinite(change) ? change : 0 });
  }
  return rows;
}

/**
 * The coin list, in the order the user wrote it.
 *
 * Comma, space and newline all separate, because the value is as often pasted
 * from a list as typed. Ids are lowercased so a capitalised `Bitcoin` works, a
 * repeat is asked for once so `<n> coins` counts coins rather than words, and
 * anything that is not an id-shaped slug is dropped before it can reach a query
 * string.
 */
function coinIds(raw: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const id = part.toLowerCase();
    if (!ID_SHAPE.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === MAX_COINS) break;
  }
  return ids;
}

export function cryptoAdapter(): LifeAdapter {
  const configured = cred("crypto.coins", "XANA_CRYPTO_COINS");
  const coins = coinIds(configured.present ? configured.value : DEFAULT_COINS.join(","));
  // The plugin id, not a name of this file's own choosing: the status row has
  // to match the id the descriptor and the permission card use, or the row is
  // one nobody can act on.
  const id = "crypto";
  const label = "Crypto";

  const read = async (): Promise<{ data: { finance: FinanceSignal[] }; status: AdapterStatus }> => {
    const t0 = Date.now();
    if (coins.length === 0) {
      // Nothing to quote, so nothing is requested. A `crypto.coins` value of
      // "!!!, ??" is a typo worth naming rather than a reason to call CoinGecko
      // with an empty `ids=`.
      return {
        data: { finance: [] },
        status: status(id, label, "error", "local", "no coin ids configured", Date.now() - t0),
      };
    }

    let rows: CoinQuote[];
    // Named rather than inlined so a failure can say which host went quiet.
    // Both quote connections fail the same way when a network blocks them, and
    // a row reading only "timed out" sends the reader looking at their coin
    // list instead of at the connection.
    const url =
      `https://api.coingecko.com/api/v3/simple/price?ids=${coins.join(",")}` +
      `&vs_currencies=usd&include_24hr_change=true`;
    try {
      // The ids need no escaping: `ID_SHAPE` above admitted nothing else.
      rows = parseCoinGecko(await httpJson<unknown>(url, { timeoutMs: 6000 }));
    } catch (err) {
      return {
        data: { finance: [] },
        status: status(id, label, "error", "local", reachFailure(hostOf(url), err), Date.now() - t0),
      };
    }

    if (rows.length === 0) {
      // A 200 with nothing usable in it is its own failure: the request
      // succeeded and the answer still cannot be shown, which is not the same
      // as "the coins did not move".
      return {
        data: { finance: [] },
        status: status(id, label, "error", "local", "no usable quote in the response", Date.now() - t0),
      };
    }

    // Keep the list in the order the user named the coins, not the order the
    // response happened to serialise them in.
    const order = new Map(coins.map((coin, i) => [coin, i]));
    rows.sort((a, b) => (order.get(a.id) ?? MAX_COINS) - (order.get(b.id) ?? MAX_COINS));

    const signals: FinanceSignal[] = rows.map((row) => ({
      label: pretty(row.id),
      value: `$${formatPrice(row.price)} ${signedChange(row.change)}`,
      trend: row.change > 0.5 ? "up" : row.change < -0.5 ? "down" : "flat",
      note: "24h",
    }));

    return {
      data: { finance: signals },
      status: status(
        id, label, "connected", "live",
        `${signals.length} coin${signals.length === 1 ? "" : "s"}`,
        Date.now() - t0,
      ),
    };
  };

  return defineAdapter<{ finance: FinanceSignal[] }>({
    id,
    label,
    ttlMs: 5 * 60_000,
    empty: { finance: [] },
    produce: read,
  });
}
