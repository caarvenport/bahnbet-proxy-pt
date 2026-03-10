/**
 * Fetches real-time train delay data from CP (Comboios de Portugal).
 *
 * Approach: Poll departure boards from major Portuguese stations using the
 * CP website's internal REST API. For each long-distance train (AP, IC, IR),
 * extract delay information and build a standard FeedSnapshot.
 *
 * The CP REST handler endpoint is used by the CP website's departure/arrival
 * boards. It accepts POST requests and returns JSON.
 *
 * No API key required — these are public web endpoints.
 *
 * Long-distance train types:
 *   AP  = Alfa Pendular (high-speed tilting train)
 *   IC  = Intercidades (intercity express)
 *   IR  = Inter-Regional
 */

// -- Types ------------------------------------------------------------------

export interface TripUpdate {
  tripId: string;
  routeId: string;
  lineName: string;
  startDate: string; // YYYYMMDD
  startTime: string; // HH:MM:SS (scheduled departure)
  runId: string; // "AP-130-20260310-0730"
  cancelled: boolean;
  departureDelaySec: number | null;
  arrivalDelaySec: number | null;
  currentDelaySec: number | null;
  trainNumber: string | null;
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

// -- Config -----------------------------------------------------------------

/** Major Portuguese stations to poll for departures. */
const STATIONS: Array<{ id: string; name: string }> = [
  { id: "94-2006", name: "Lisboa Santa Apolonia" },
  { id: "94-39008", name: "Lisboa Oriente" },
  { id: "94-8007", name: "Porto Campanha" },
  { id: "94-25007", name: "Coimbra-B" },
  { id: "94-68007", name: "Faro" },
];

/** Long-distance train product types to include. */
const LD_PRODUCTS = new Set(["AP", "IC", "IR"]);

/**
 * CP REST handler endpoint.
 * The CP website calls this endpoint for departure/arrival data.
 *
 * TODO: Verify this endpoint is accessible and returns the expected JSON
 * format. If it doesn't work, alternative approaches:
 *   1. Try https://api.cp.pt/cp-api/siv/stations/departures/{stationId}
 *   2. Try scraping https://www.cp.pt/passageiros/en/train-times/Departures
 *   3. Use Infraestruturas de Portugal API (trainstatus.pt approach)
 */
const CP_REST_URL =
  "https://www.cp.pt/sites/passageiros/pt/_vti_bin/resthandler.ashx/customREST/";

// -- State ------------------------------------------------------------------

let latest: { json: string; data: FeedSnapshot } | null = null;

export function getSnapshot() {
  return latest;
}

// -- Fetch & filter ---------------------------------------------------------

export async function fetchAndFilter(): Promise<void> {
  const t0 = Date.now();
  console.log("[rt] Polling CP station departure boards...");

  // Collect all departures from all stations in parallel
  const results = await Promise.allSettled(
    STATIONS.map((s) => fetchStationDepartures(s.id, s.name)),
  );

  // Merge departures, deduplicating by train number + date
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
    const departures = result.value;
    totalEntities += departures.length;

    for (const dep of departures) {
      // Only keep long-distance products
      if (!dep.product || !LD_PRODUCTS.has(dep.product.toUpperCase())) continue;

      const key = `${dep.trainNumber}-${dep.dateStr}`;
      const existing = trainMap.get(key);

      if (!existing) {
        trainMap.set(key, dep);
      } else {
        // Update with most recent delay info if available
        if (dep.delaySec != null && existing.delaySec == null) {
          existing.delaySec = dep.delaySec;
        }
        // Keep the latest delay info we have
        if (dep.delaySec != null) {
          existing.currentDelaySec = dep.delaySec;
        }
      }
    }
  }

  // Build FeedSnapshot
  const trips: Record<string, TripUpdate> = {};
  let tripCount = 0;

  for (const [key, entry] of trainMap) {
    const product = entry.product?.toUpperCase() ?? "IC";
    const depHHMM = entry.scheduledTime
      ? entry.scheduledTime.slice(0, 2) + entry.scheduledTime.slice(3, 5)
      : "0000";

    const runId =
      product && entry.trainNumber && entry.dateStr
        ? `${product}-${entry.trainNumber}-${entry.dateStr}-${depHHMM}`
        : "";

    const tripId = `cp-${key}`;
    const lineName = `${product} ${entry.trainNumber}`;

    trips[tripId] = {
      tripId,
      routeId: product,
      lineName,
      startDate: entry.dateStr,
      startTime: entry.scheduledTime ?? "",
      runId,
      cancelled: entry.cancelled,
      departureDelaySec: entry.delaySec,
      arrivalDelaySec: null, // We only get departure info from station boards
      currentDelaySec: entry.currentDelaySec ?? entry.delaySec,
      trainNumber: entry.trainNumber,
    };
    tripCount++;
  }

  const data: FeedSnapshot = {
    meta: {
      updatedAt: new Date().toISOString(),
      feedTimestamp: new Date().toISOString(),
      tripCount,
      totalEntities,
      staticLoadedAt: null, // No static feed for PT
    },
    trips,
  };

  latest = { json: JSON.stringify(data), data };

  console.log(
    `[rt] ${tripCount} LD trains from ${totalEntities} total departures across ${STATIONS.length} stations in ${Date.now() - t0}ms`,
  );
}

// -- Station departure fetcher ----------------------------------------------

interface TrainEntry {
  trainNumber: string;
  product: string; // "AP", "IC", "IR"
  dateStr: string; // YYYYMMDD
  scheduledTime: string | null; // HH:MM
  delaySec: number | null;
  currentDelaySec: number | null;
  cancelled: boolean;
}

/**
 * Fetch departures from a CP station via the REST handler API.
 *
 * The CP REST handler accepts POST requests with a JSON body specifying
 * the operation. The expected response contains train departure info
 * including scheduled times, delays, and train types.
 *
 * TODO: The exact request/response format needs verification against the
 * live CP endpoint. The structure below is based on the comboios npm
 * package's reverse-engineering of the CP API.
 */
async function fetchStationDepartures(
  stationId: string,
  stationName: string,
): Promise<TrainEntry[]> {
  const today = getTodayDateStr();

  // Attempt 1: CP REST handler (used by website)
  try {
    return await fetchViaRestHandler(stationId, stationName, today);
  } catch (err) {
    console.warn(
      `[rt] REST handler failed for ${stationName}: ${(err as Error).message}`,
    );
  }

  // Attempt 2: CP API endpoint (used by mobile app)
  try {
    return await fetchViaCpApi(stationId, stationName, today);
  } catch (err) {
    console.warn(
      `[rt] CP API failed for ${stationName}: ${(err as Error).message}`,
    );
  }

  return [];
}

/**
 * Fetch via CP website REST handler.
 *
 * POST to the customREST endpoint with a JSON body.
 * Based on the comboios npm package's reverse-engineering.
 */
async function fetchViaRestHandler(
  stationId: string,
  stationName: string,
  today: string,
): Promise<TrainEntry[]> {
  const body = JSON.stringify({
    getNextTrains: {
      stationCode: stationId,
      numTrains: 30,
    },
  });

  const res = await fetch(CP_REST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; BahnBet/1.0)",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json: unknown = await res.json();
  return parseRestHandlerResponse(json, today);
}

/**
 * Parse the REST handler JSON response into TrainEntry[].
 *
 * TODO: The exact response structure needs to be verified. Expected format
 * based on known CP API patterns:
 * {
 *   "response": [
 *     {
 *       "trainNumber": "130",
 *       "trainType": "AP",
 *       "scheduledDeparture": "07:30",
 *       "estimatedDeparture": "07:35",
 *       "destination": "Faro",
 *       "cancelled": false
 *     }
 *   ]
 * }
 *
 * Actual field names may differ. Common patterns seen:
 * - "comboio" (train), "tipo" (type), "hora" (time), "atraso" (delay)
 */
function parseRestHandlerResponse(
  json: unknown,
  today: string,
): TrainEntry[] {
  const entries: TrainEntry[] = [];

  if (!json || typeof json !== "object") return entries;

  // Try multiple known response shapes
  const data = json as Record<string, unknown>;

  // Shape 1: { response: [...] }
  let trains: unknown[] | null = null;
  if (Array.isArray(data.response)) {
    trains = data.response;
  }
  // Shape 2: { getNextTrainsResponse: { train: [...] } }
  else if (
    data.getNextTrainsResponse &&
    typeof data.getNextTrainsResponse === "object"
  ) {
    const inner = data.getNextTrainsResponse as Record<string, unknown>;
    if (Array.isArray(inner.train)) trains = inner.train;
    else if (Array.isArray(inner.trains)) trains = inner.trains;
  }
  // Shape 3: Top-level array
  else if (Array.isArray(json)) {
    trains = json;
  }
  // Shape 4: { d: [...] } (SharePoint REST pattern)
  else if (Array.isArray(data.d)) {
    trains = data.d;
  }
  // Shape 5: { d: { results: [...] } }
  else if (data.d && typeof data.d === "object") {
    const d = data.d as Record<string, unknown>;
    if (Array.isArray(d.results)) trains = d.results;
  }

  if (!trains) {
    console.warn(
      `[rt] Unknown response shape, keys: ${Object.keys(data).join(", ")}`,
    );
    return entries;
  }

  for (const t of trains) {
    if (!t || typeof t !== "object") continue;
    const train = t as Record<string, unknown>;

    const entry = extractTrainEntry(train, today);
    if (entry) entries.push(entry);
  }

  return entries;
}

/**
 * Extract a TrainEntry from a raw train object.
 * Tries multiple possible field name patterns (PT and EN).
 */
function extractTrainEntry(
  train: Record<string, unknown>,
  today: string,
): TrainEntry | null {
  // Train number: "trainNumber", "comboio", "numero", "nComboio", "trainNo"
  const trainNumber = String(
    train.trainNumber ??
      train.comboio ??
      train.numero ??
      train.nComboio ??
      train.trainNo ??
      train.TrainNumber ??
      train.Comboio ??
      "",
  ).trim();

  if (!trainNumber) return null;

  // Product type: "trainType", "tipo", "type", "product", "tipoComboio"
  const product = String(
    train.trainType ??
      train.tipo ??
      train.type ??
      train.product ??
      train.tipoComboio ??
      train.TrainType ??
      train.Tipo ??
      "",
  )
    .trim()
    .toUpperCase();

  // Scheduled time: "scheduledDeparture", "hora", "horaPartida", "departureTime"
  const scheduledRaw = String(
    train.scheduledDeparture ??
      train.hora ??
      train.horaPartida ??
      train.departureTime ??
      train.HoraPartida ??
      train.scheduledTime ??
      "",
  ).trim();
  const scheduledTime = normalizeTime(scheduledRaw);

  // Estimated/actual time: "estimatedDeparture", "horaEstimada", "horaReal"
  const estimatedRaw = String(
    train.estimatedDeparture ??
      train.horaEstimada ??
      train.horaReal ??
      train.estimatedTime ??
      train.HoraEstimada ??
      train.actualDeparture ??
      "",
  ).trim();
  const estimatedTime = normalizeTime(estimatedRaw);

  // Delay: some APIs return delay directly as minutes
  const delayMinRaw =
    train.atraso ?? train.delay ?? train.delayMinutes ?? train.Atraso;
  let delaySec: number | null = null;

  if (delayMinRaw != null && delayMinRaw !== "" && delayMinRaw !== false) {
    const mins = Number(delayMinRaw);
    if (!isNaN(mins)) {
      delaySec = mins * 60;
    }
  } else if (scheduledTime && estimatedTime) {
    delaySec = computeDelaySec(scheduledTime, estimatedTime);
  }

  // Cancelled
  const cancelled = Boolean(
    train.cancelled ??
      train.cancelado ??
      train.suprimido ??
      train.Cancelado ??
      train.Suprimido ??
      false,
  );

  return {
    trainNumber,
    product,
    dateStr: today,
    scheduledTime,
    delaySec,
    currentDelaySec: delaySec,
    cancelled,
  };
}

/**
 * Fetch via CP mobile app API endpoint.
 *
 * TODO: This endpoint URL is speculative. May need adjustment based on
 * actual CP infrastructure. Known patterns:
 *   - https://api.cp.pt/cp-api/siv/stations/departures/{stationId}
 *   - https://api.cp.pt/cp-api/siv/stations/{stationId}/board/departure
 */
async function fetchViaCpApi(
  stationId: string,
  stationName: string,
  today: string,
): Promise<TrainEntry[]> {
  // Try the SIV (Sistema de Informacao ao Viajante) API
  const url = `https://api.cp.pt/cp-api/siv/stations/${encodeURIComponent(stationId)}/board/departure`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; BahnBet/1.0)",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json: unknown = await res.json();
  return parseRestHandlerResponse(json, today);
}

// -- Helpers ----------------------------------------------------------------

/** Get today's date as YYYYMMDD in Lisbon timezone. */
function getTodayDateStr(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // Returns "2026-03-10" format
  return fmt.format(now).replace(/-/g, "");
}

/**
 * Normalize a time string to HH:MM format.
 * Handles: "07:30", "7:30", "07:30:00", "07h30", "0730"
 */
function normalizeTime(raw: string): string | null {
  if (!raw || raw === "undefined" || raw === "null") return null;

  // "07:30:00" or "07:30"
  const colonMatch = raw.match(/^(\d{1,2}):(\d{2})/);
  if (colonMatch) {
    return `${colonMatch[1].padStart(2, "0")}:${colonMatch[2]}`;
  }

  // "07h30"
  const hMatch = raw.match(/^(\d{1,2})h(\d{2})/i);
  if (hMatch) {
    return `${hMatch[1].padStart(2, "0")}:${hMatch[2]}`;
  }

  // "0730"
  if (/^\d{4}$/.test(raw)) {
    return `${raw.slice(0, 2)}:${raw.slice(2, 4)}`;
  }

  return null;
}

/**
 * Compute delay in seconds from two HH:MM time strings.
 * Handles midnight crossing (e.g., scheduled 23:50, actual 00:05 = +15 min).
 */
function computeDelaySec(
  scheduled: string,
  actual: string,
): number | null {
  const sParts = scheduled.split(":");
  const aParts = actual.split(":");
  if (sParts.length < 2 || aParts.length < 2) return null;

  const sMin = parseInt(sParts[0], 10) * 60 + parseInt(sParts[1], 10);
  const aMin = parseInt(aParts[0], 10) * 60 + parseInt(aParts[1], 10);

  if (isNaN(sMin) || isNaN(aMin)) return null;

  let diff = aMin - sMin;
  // Handle midnight crossing: if diff is very negative, assume next day
  if (diff < -720) diff += 1440; // 24*60
  // If diff is very positive (>12h), assume previous day
  if (diff > 720) diff -= 1440;

  return diff * 60; // Convert minutes to seconds
}
