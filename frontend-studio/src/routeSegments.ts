// Splits ONE combined route polyline (all Google Directions handles back is a
// single flat point list — no per-leg geometry) into per-leg point arrays, by
// nearest-point matching each waypoint onto the path in order. The search
// window only ever moves forward (never re-considers points before the
// previous waypoint's match), so a switchback near one waypoint can't pull a
// later waypoint's match backwards — same safeguard as the backend's
// _nearest_point_index/_pick_via_indices in services/stops.py, ported here
// because Directions only gives the frontend one combined shape to work with.
function nearestPointIndices(
  path: { lat: number; lng: number }[],
  waypoints: { lat: number; lng: number }[]
): number[] {
  const indices: number[] = [];
  let searchFrom = 0;

  for (const wp of waypoints) {
    let bestIdx = searchFrom;
    let bestDist = Infinity;
    for (let i = searchFrom; i < path.length; i++) {
      const dLat = path[i].lat - wp.lat;
      const dLng = path[i].lng - wp.lng;
      const d = dLat * dLat + dLng * dLng;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    indices.push(bestIdx);
    searchFrom = bestIdx;
  }

  return indices;
}

// `waypoints` is the full stop sequence including origin and destination
// (length = legCount + 1) — same order as the stops array sent to
// /detail-route, which is the same order day_split.py's stop_indices index
// into. Returns one point array per leg (waypoints.length - 1 of them);
// segment i and i+1 share their boundary point so adjacent colors touch with
// no visual gap.
export function splitPathIntoLegs(
  path: { lat: number; lng: number }[],
  waypoints: { lat: number; lng: number }[]
): { lat: number; lng: number }[][] {
  if (path.length === 0 || waypoints.length < 2) return [];

  const indices = nearestPointIndices(path, waypoints);
  const segments: { lat: number; lng: number }[][] = [];
  for (let i = 0; i < indices.length - 1; i++) {
    segments.push(path.slice(indices[i], indices[i + 1] + 1));
  }
  return segments;
}
