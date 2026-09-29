/**
 * Finance adapter — ambient signals, not a portfolio tracker.
 *
 * Quotes come from Stooq's public CSV endpoint, which needs no key. Xana reads
 * a handful of symbols (indices and a couple of currencies by default) and
 * distils them into at most three lines, because "the market" is context, not
 * a thing to stare at.
 *
 *   XANA_FINANCE_SYMBOLS="^spx,^ndq,eurusd"
 */

import type { AdapterStatus, FinanceSignal } from "../core/types";
import { cred, defineAdapter, errorMessage, httpText, status, type LifeAdapter } from "./types";

const DEFAULT_SYMBOLS = ["^spx", "^ndq", "eurusd", "gbpusd"];

const FRIENDLY: Record<string, string> = {
  "^spx": "S&P 500",
  "^ndq": "Nasdaq",
  "^dji": "Dow",
  "^ftm": "FTSE",
  "^dax": "DAX",
  "^nikkei": "Nikkei",
  eurusd: "EUR/USD",
  gbpusd: "GBP/USD",
  usdjpy: "USD/JPY",
  btcusd: "BTC",
  ethusd: "ETH",
  xauusd: "Gold",
  cl: "Crude",
};

function pretty(symbol: string): string {
  return FRIENDLY[symbol.toLowerCase()] ?? symbol.replace(/^\^/, "").toUpperCase();
}

function formatValue(v: number): string {
  if (v >= 10_000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (v >= 100) return v.toFixed(2);
  return v.toFixed(4);
}

interface Quote { symbol: string; close: number; prev: number; date: string }

/** Stooq returns: Symbol,Date,Time,Open,High,Low,Close,Volume */
export function parseStooqCsv(csv: string, symbol: string): Quote | undefined {
  const lines = csv.trim().split("\n");
  if (lines.length < 3) return undefined;
  const rows = lines.slice(1).map((l) => l.split(","));
  // Prefer the last two rows with a numeric close, so intraday blanks are skipped.
  const valid = rows.filter((r) => r.length >= 7 && Number.isFinite(Number(r[6])) && Number(r[6]) > 0);
  if (valid.length === 0) return undefined;
  const last = valid[valid.length - 1];
  const prev = valid.length > 1 ? valid[valid.length - 2] : last;
  return { symbol, close: Number(last[6]), prev: Number(prev[6]), date: last[1] };
}

export function financeAdapter(): LifeAdapter {
  const symbolsCred = cred("XANA_FINANCE_SYMBOLS");
  const symbols = (symbolsCred.present ? symbolsCred.value.split(/[,\s]+/) : DEFAULT_SYMBOLS).filter(Boolean);
  const enabled = process.env.XANA_FINANCE !== "off";
  const id = "finance";
  const label = "Markets";

  const read = async (): Promise<{ data: { finance: FinanceSignal[] }; status: AdapterStatus }> => {
    const t0 = Date.now();
    if (!enabled) {
      return {
        data: { finance: [] },
        status: status(id, label, "offline", "local", "disabled (XANA_FINANCE=off)", Date.now() - t0),
      };
    }

    const signals: FinanceSignal[] = [];
    const failures: string[] = [];

    await Promise.all(
      symbols.slice(0, 6).map(async (sym) => {
        try {
          const csv = await httpText(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`, {
            timeoutMs: 5000,
          });
          const q = parseStooqCsv(csv, sym);
          if (!q) {
            failures.push(`${sym}: no data`);
            return;
          }
          const changePct = q.prev ? ((q.close - q.prev) / q.prev) * 100 : 0;
          signals.push({
            label: pretty(sym),
            value: `${formatValue(q.close)}  ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`,
            trend: changePct > 0.15 ? "up" : changePct < -0.15 ? "down" : "flat",
            note: q.date,
          });
        } catch (err) {
          failures.push(`${sym}: ${errorMessage(err)}`);
        }
      }),
    );

    if (signals.length === 0) {
      return {
        data: { finance: [] },
        status: status(id, label, "error", "local", failures[0] ?? "no quotes", Date.now() - t0),
      };
    }

    // Keep the list in the order the user named the symbols.
    const order = new Map(symbols.map((s, i) => [pretty(s), i]));
    signals.sort((a, b) => (order.get(a.label) ?? 99) - (order.get(b.label) ?? 99));

    return {
      data: { finance: signals },
      status: status(
        id, label, "connected", "live",
        `${signals.length} quotes${failures.length ? ` · ${failures.length} failed` : ""}`,
        Date.now() - t0,
      ),
    };
  };

  return defineAdapter<{ finance: FinanceSignal[] }>({
    id,
    label,
    ttlMs: 10 * 60_000,
    empty: { finance: [] },
    produce: read,
  });
}
