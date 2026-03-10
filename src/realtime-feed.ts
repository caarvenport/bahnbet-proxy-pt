/**
 * Fetches real-time train delay data from CP (Comboios de Portugal)
 * via the api-gateway.cp.pt travel API.
 *
 * The CP website (rebuilt as a Vite SPA) exposes its config including
 * API keys at /fe-config.json. The travel API provides structured JSON
 * with integer delay values per stop, train status, and GPS coordinates.
 *
 * No registration needed — uses public API keys from the CP frontend config.
 *
 * Long-distance train service types:
 *   1  = Alfa Pendular (AP) — high-speed tilting train
 *   2  = Intercidades (IC) — intercity express
 *   3  = InterRegionais (IR) — inter-regional
 *   12 = Internacionais (IN) — international
 */

import { getStopName } from "./static-feed.js";

// -- Config -----------------------------------------------------------------

const CP_API_BASE =
  "https://api-gateway.cp.pt/cp/services/travel-api";

/** Public API keys from https://www.cp.pt/fe-config.json */
const CP_HEADERS = {
  "X-Api-Key": "ca3923e4-1d3c-424f-a3d0-9554cf3ef859",
  "x-cp-connect-id": "1483ea620b920be6328dcf89e808937a",
  "x-cp-connect-secret": "74bd06d5a2715c64c2f848c5cdb56e6b",
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; BahnBet/1.0)",
};

/** Major Portuguese stations to poll. Code format: "94-XXXXX" */
const STATIONS = [
  { code: "94-31039", name: "Lisboa Oriente" },
  { code: "94-30007", name: "Lisboa Santa Apolonia" },
  { code: "94-2006", name: "Porto Campanha" },
  { code: "94-25007", name: "Coimbra-B" },
  { code: "94-68007", name: "Faro" },
  { code: "94-35004", name: "Braga" },
  { code: "94-42002", name: "Evora" },
];

/** Service type codes for long-distance trains (from trainService.code) */
const LD_SERVICE_CODES = new Set(["AP", "IC", "IR", "IN"]);

// -- Types ------------------------------------------------------------------

export interface TripUpdate {
  tripId: string;
  routeId: string;
  lineName: string;
  startDate: string;         // YYYYMMDD
  startTime: string;         // HH:MM:SS (scheduled departure)
  runId: string;             // "AP-130-20260310-0730"
  cancelled: boolean;
  departureDelaySec: number | null;
  arrivalDelaySec: number | null;
  currentDelaySec: number | null;
  trainNumber: string | null;
  originName: string | null;
  destinationName: string | null;
  scheduledArrival: string | null;
}

export interface FeedSnapshot {
  meta: {
    updatedAt: string;
    feedTimestamp: string;
    tripCount: number;
    totalEntities: number;
    staticLoadedAt: string | null;
  };
  trips: Record<string, TripUpdate>;
}

// -- CP API response types --------------------------------------------------

interface CpStationTimetableEntry {
  trainNumber?: number | string;
  serviceCode?: number;
  serviceType?: string;
  origin?: string;
  destination?: string;
  departureTime?: string;    // "HH:MM" scheduled
  arrivalTime?: string;
  ETD?: string;              // estimated time of departure
  ETA?: string;              // estimated time of arrival
  delay?: number;            // minutes
  status?: string;           // "IN_TRANSIT", "SCHEDULED", etc.
  supression?: boolean;      // cancellation flag
  platform?: string;
  occupancy?: number;
}

// -- State ------------------------------------------------------------------

let latest: { json: string; data: FeedSnapshot } | null = null;

export function getSnapshot() {
  return latest;
}

// -- Fetch & filter ---------------------------------------------------------

export async function fetchAndFilter(): Promise<void> {
  const t0 = Date.now();
  console.log("[rt] Polling CP travel API for station timetables...");

  const today = getTodayDateStr();

  // Poll all stations in parallel
  const results = await Promise.allSettled(
    STATIONS.map((s) => fetchStationTimetable(s.code, s.name, today)),
  );

  // Merge trains, deduplicating by train number + date
  const trainMap = new Map<string, TrainEntry>();
  let totalEntities = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      console.warn(
        `[rt] Station ${STATIONS[i].name} failed: ${result.reason}`,
      );
      continue;
    }
    const entries = result.value;
    totalEntities += entries.length;

    for (const entry of entries) {
      const key = `${entry.trainNumber}-${entry.dateStr}`;
      const existing = trainMap.get(key);

      if (!existing) {
        trainMap.set(key, entry);
      } else {
        // Update with most recent delay info
        if (entry.delaySec != null) {
          existing.currentDelaySec = entry.delaySec;
        }
      }
    }
  }

  // Build FeedSnapshot
  const trips: Record<string, TripUpdate> = {};
  let tripCount = 0;

  for (const [key, entry] of trainMap) {
    const depHHMM = entry.scheduledTime
      ? entry.scheduledTime.replace(":", "")
      : "0000";

    const runId =
      entry.product && entry.trainNumber && entry.dateStr
        ? `${entry.product}-${entry.trainNumber}-${entry.dateStr}-${depHHMM}`
        : "";

    const tripId = `cp-${key}`;
    const lineName = `${entry.product} ${entry.trainNumber}`;

    trips[tripId] = {
      tripId,
      routeId: entry.product,
      lineName,
      startDate: entry.dateStr,
      startTime: entry.scheduledTime ? `${entry.scheduledTime}:00` : "",
      runId,
      cancelled: entry.cancelled,
      departureDelaySec: entry.delaySec,
      arrivalDelaySec: null,
      currentDelaySec: entry.currentDelaySec ?? entry.delaySec,
      trainNumber: entry.trainNumber,
      originName: entry.originName,
      destinationName: entry.destinationName,
      scheduledArrival: null,
    };
    tripCount++;
  }

  const data: FeedSnapshot = {
    meta: {
      updatedAt: new Date().toISOString(),
      feedTimestamp: new Date().toISOString(),
      tripCount,
      totalEntities,
      staticLoadedAt: null,
    },
    trips,
  };

  latest = { json: JSON.stringify(data), data };

  console.log(
    `[rt] ${tripCount} LD trains from ${totalEntities} total entries across ${STATIONS.length} stations in ${Date.now() - t0}ms`,
  );
}

// -- Station timetable fetcher ----------------------------------------------

interface TrainEntry {
  trainNumber: string;
  product: string;
  dateStr: string;
  scheduledTime: string | null; // HH:MM
  delaySec: number | null;
  currentDelaySec: number | null;
  cancelled: boolean;
  originName: string | null;
  destinationName: string | null;
}

async function fetchStationTimetable(
  stationCode: string,
  stationName: string,
  date: string,
): Promise<TrainEntry[]> {
  // Format date as YYYY-MM-DD for the API
  const dateFormatted = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const url = `${CP_API_BASE}/stations/${encodeURIComponent(stationCode)}/timetable/${dateFormatted}`;

  const res = await fetch(url, {
    method: "GET",
    headers: CP_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json: unknown = await res.json();
  return parseStationResponse(json, date);
}

function parseStationResponse(json: unknown, today: string): TrainEntry[] {
  const entries: TrainEntry[] = [];

  if (!json || typeof json !== "object") return entries;
  const data = json as Record<string, unknown>;

  // CP API returns { stationStops: [...] }
  const stops = Array.isArray(data.stationStops)
    ? data.stationStops
    : Array.isArray(json)
      ? (json as unknown[])
      : [];

  for (const t of stops) {
    if (!t || typeof t !== "object") continue;
    const train = t as Record<string, unknown>;

    // Service type: { trainService: { code: "AP", designation: "Alfa Pendular" } }
    const svc = train.trainService as Record<string, unknown> | undefined;
    const product = String(svc?.code ?? "").trim();
    if (!LD_SERVICE_CODES.has(product)) continue;

    // Train number
    const trainNum = String(train.trainNumber ?? "").trim();
    if (!trainNum) continue;

    // Scheduled departure time (HH:MM format)
    const scheduledTime = normalizeTime(
      String(train.departureTime ?? train.arrivalTime ?? ""),
    );

    // Delay (integer minutes from API)
    let delaySec: number | null = null;
    if (train.delay != null && train.delay !== "") {
      const delayMin = Number(train.delay);
      if (!isNaN(delayMin)) {
        delaySec = delayMin * 60;
      }
    }

    // If no explicit delay but we have ETD and scheduled time, compute it
    if (delaySec == null && scheduledTime) {
      const etd = normalizeTime(String(train.ETD ?? ""));
      if (etd) {
        delaySec = computeDelayMinutes(scheduledTime, etd) * 60;
      }
    }

    // Cancellation
    const cancelled = Boolean(train.supression ?? false);

    // Extract origin/destination names from the timetable entry
    const originStr = typeof train.origin === "string" ? train.origin.trim() : null;
    const destStr = typeof train.destination === "string" ? train.destination.trim() : null;

    entries.push({
      trainNumber: trainNum,
      product,
      dateStr: today,
      scheduledTime,
      delaySec,
      currentDelaySec: delaySec,
      cancelled,
      originName: originStr || null,
      destinationName: destStr || null,
    });
  }

  return entries;
}

// -- Helpers ----------------------------------------------------------------

function getTodayDateStr(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now).replace(/-/g, "");
}

function normalizeTime(raw: string): string | null {
  if (!raw || raw === "undefined" || raw === "null") return null;
  const m = raw.match(/^(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  if (/^\d{4}$/.test(raw)) return `${raw.slice(0, 2)}:${raw.slice(2, 4)}`;
  return null;
}

function computeDelayMinutes(scheduled: string, actual: string): number {
  const [sh, sm] = scheduled.split(":").map(Number);
  const [ah, am] = actual.split(":").map(Number);
  let diff = (ah * 60 + am) - (sh * 60 + sm);
  if (diff < -720) diff += 1440;
  if (diff > 720) diff -= 1440;
  return diff;
}
