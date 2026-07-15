import { Day, Coordinate } from './types';
import { COORDS } from './data';

export interface ExportDay {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  stops: Array<{ lat: number; lng: number }>;
}

/**
 * Maps a standard Day object to ExportDay coordinates format.
 */
export function getExportDayData(day: Day, removedIndices: number[]): ExportDay {
  const routePoints: Record<number, { origin: Coordinate; destination: Coordinate }> = {
    1: { origin: { lat: 39.7392, lng: -104.9903 }, destination: { lat: 39.5505, lng: -107.3248 } },
    2: { origin: { lat: 39.5505, lng: -107.3248 }, destination: { lat: 38.5733, lng: -109.5498 } },
    3: { origin: { lat: 38.5733, lng: -109.5498 }, destination: { lat: 36.9147, lng: -111.4558 } },
    4: { origin: { lat: 36.9147, lng: -111.4558 }, destination: { lat: 37.0475, lng: -112.5263 } },
    5: { origin: { lat: 37.0475, lng: -112.5263 }, destination: { lat: 37.0965, lng: -113.5684 } },
    6: { origin: { lat: 37.0965, lng: -113.5684 }, destination: { lat: 36.1699, lng: -115.1398 } },
  };

  const points = routePoints[day.n] || {
    origin: { lat: 39.7392, lng: -104.9903 },
    destination: { lat: 36.1699, lng: -115.1398 },
  };

  const activeStops = day.stops
    .filter((stop) => !removedIndices.includes(stop.i))
    .map((stop) => COORDS[stop.i] || { lat: 39.7392, lng: -104.9903 });

  return {
    origin: points.origin,
    destination: points.destination,
    stops: activeStops,
  };
}

/**
 * Builds a Google Maps routing URL for the given day.
 */
export function buildGoogleMapsUrl(day: ExportDay): string {
  const originStr = `${day.origin.lat},${day.origin.lng}`;
  const destStr = `${day.destination.lat},${day.destination.lng}`;
  let url = `https://www.google.com/maps/dir/?api=1&origin=${originStr}&destination=${destStr}&travelmode=driving`;
  
  if (day.stops && day.stops.length > 0) {
    const waypointsStr = day.stops.map(s => `${s.lat},${s.lng}`).join('|');
    url += `&waypoints=${encodeURIComponent(waypointsStr)}`;
  }
  
  return url;
}

/**
 * Builds an Apple Maps routing URL for the given day.
 */
export function buildAppleMapsUrl(day: ExportDay): string {
  const originStr = `${day.origin.lat},${day.origin.lng}`;
  const destStr = `${day.destination.lat},${day.destination.lng}`;
  return `http://maps.apple.com/?saddr=${originStr}&daddr=${destStr}`;
}

