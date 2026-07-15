import polyline from "@mapbox/polyline";

const API_URL = "http://localhost:8000";

export interface RouteResult {
  duration_seconds: number;
  distance_km: number;
  has_time_restrictions: boolean;
  shape: string;
}

export async function fetchRoute(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
): Promise<RouteResult> {
  const params = new URLSearchParams({
    start_lat: String(startLat),
    start_lon: String(startLon),
    end_lat: String(endLat),
    end_lon: String(endLon),
  });

  const res = await fetch(`${API_URL}/route?${params}`);
  if (!res.ok) throw new Error(`Route request failed: ${res.status}`);
  return res.json();
}

export function decodeShape(shape: string): { lat: number; lng: number }[] {
  // Valhalla кодирует с precision 6, не 5 как Google
  return polyline.decode(shape, 6).map(([lat, lng]) => ({ lat, lng }));
}

export interface GeocodeResult {
  name: string;
  lat: number;
  lng: number;
  formatted_address: string;
}

export async function geocode(query: string): Promise<GeocodeResult> {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`${API_URL}/geocode?${params}`);

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Geocode request failed: ${res.status}`);
  }

  return res.json();
}

export interface ReverseGeocodeResult {
  name: string;
  formatted_address: string;
}

export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
  const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
  const res = await fetch(`${API_URL}/reverse-geocode?${params}`);

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Reverse geocode request failed: ${res.status}`);
  }

  return res.json();
}