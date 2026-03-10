/**
 * Portugal (CP) Train Delay Proxy
 *
 * Polls CP (Comboios de Portugal) station departure boards for real-time
 * delay data on long-distance trains (AP, IC, IR).
 *
 * No env vars required — CP endpoints are public.
 *
 * Train types:
 *   AP  = Alfa Pendular — high-speed tilting train (Lisboa-Porto-Faro)
 *   IC  = Intercidades — intercity express
 *   IR  = Inter-Regional
 *
 * Designed for Railway free tier: 0.5 vCPU, 512 MB RAM.
 */

import http from "node:http";
import { fetchAndFilter, getSnapshot } from "./realtime-feed.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const RT_INTERVAL = 120_000; // fetch every 2 min (conservative for web scraping)

// -- Main -------------------------------------------------------------------

async function main() {
  console.log("[proxy-pt] CP Train Delay Proxy starting...");

  // 1. Start HTTP server immediately so healthcheck passes during data load
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    // GET /feed -- filtered long-distance train delay data
    if (url.pathname === "/feed" && req.method === "GET") {
      const snap = getSnapshot();
      if (!snap) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end('{"error":"No data available yet"}');
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30",
      });
      res.end(snap.json);
      return;
    }

    // GET /health -- service status
    if (url.pathname === "/health") {
      const snap = getSnapshot();
      const now = Date.now();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          country: "PT",
          uptime: Math.floor(process.uptime()),
          lastUpdate: snap?.data.meta.updatedAt ?? null,
          tripCount: snap?.data.meta.tripCount ?? 0,
          ageSeconds: snap
            ? Math.floor(
                (now - new Date(snap.data.meta.updatedAt).getTime()) / 1000,
              )
            : null,
          memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"Not found"}');
  });

  server.listen(PORT, () => {
    console.log(`[proxy-pt] Listening on :${PORT}`);
  });

  // 2. First RT fetch (no static feed needed for PT — station polling only)
  try {
    await fetchAndFilter();
  } catch (err) {
    console.error(
      "[rt] Initial fetch failed (will retry on schedule):",
      err,
    );
  }

  // 3. Periodic refresh
  setInterval(async () => {
    try {
      await fetchAndFilter();
    } catch (err) {
      console.error("[rt] Fetch error:", (err as Error).message);
    }
  }, RT_INTERVAL);
}

main().catch((err) => {
  console.error("[proxy-pt] Fatal:", err);
  process.exit(1);
});
