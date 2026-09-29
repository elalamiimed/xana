/**
 * Minimal HTTP harness for the real route handlers.
 *
 * `next dev` and `next build`'s page-data phase fork worker processes, which
 * some sandboxes deny. This serves the actual `route.ts` handler modules over
 * real HTTP so the transport hop can be verified independently of Next's
 * worker pool.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/serve.ts [port]
 *
 * IMPORTANT: this serves the real database and real adapters, so a request can
 * genuinely write — `POST /api/chat` with "remind me to…" creates a reminder.
 * That is the point when you are demoing, and a nuisance when you are probing,
 * so it says so out loud on boot. Use `npm run smoke` for a non-destructive
 * pass against a scratch database.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { defaultDbPath } from "../src/lib/core/store";

const port = Number(process.argv[2] ?? 4321);

type Handler = (request: Request) => Promise<Response>;

const routes = new Map<string, { method: string; load: () => Promise<Handler> }>();

function register(method: string, pathname: string, load: () => Promise<Handler>): void {
  routes.set(`${method} ${pathname}`, { method, load });
}

register("GET", "/api/state", async () => (await import("../src/app/api/state/route")).GET);
register("GET", "/api/context", async () => (await import("../src/app/api/context/route")).GET);
register("GET", "/xana/context", async () => (await import("../src/app/xana/context/route")).GET);
register("POST", "/api/chat", async () => (await import("../src/app/api/chat/route")).POST);
register("POST", "/api/action", async () => (await import("../src/app/api/action/route")).POST);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const key = `${req.method} ${url.pathname}`;
  const route = routes.get(key);

  if (!route) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found", path: url.pathname, hint: "routes: " + [...routes.keys()].join(", ") }));
    return;
  }

  try {
    const method = req.method ?? "GET";
    const body = method === "POST" ? await readBody(req) : undefined;
    const request = new Request(url, {
      method,
      headers: req.headers as Record<string, string>,
      body,
    });

    const handler = await route.load();
    const response = await handler(request);
    const text = await response.text();

    const headers: Record<string, string> = { "content-type": "application/json" };
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() !== "content-length") headers[name] = value;
    });
    res.writeHead(response.status, headers);
    res.end(text);
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "handler_threw", message: err instanceof Error ? err.message : String(err) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Xana route harness on http://127.0.0.1:${port}`);
  console.log(`Database: ${defaultDbPath()}`);
  console.log("Writes are real. `npm run smoke` is the non-destructive alternative.");
  console.log("Routes:");
  for (const key of routes.keys()) console.log(`  ${key}`);
});
