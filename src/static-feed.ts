/**
 * No GTFS static feed for Portugal — data comes from the CP travel API.
 * This module exports a no-op getStopName for interface compatibility.
 */

export function getStopName(_stopId: string): string | undefined {
  return undefined;
}
