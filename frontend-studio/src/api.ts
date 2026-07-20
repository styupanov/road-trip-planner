import polyline from "@mapbox/polyline";

// Routed through the Vite dev server's /api proxy (see vite.config.ts) so the
// browser sees the backend as same-origin — the rtp_session cookie
// (SameSite=Lax, Secure=false for local http) doesn't reliably survive a
// direct cross-origin fetch to :8000 otherwise. The proxy strips /api before
// forwarding, so backend routes are unprefixed exactly as before.
const API_URL = "/api";

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

  const res = await fetch(`${API_URL}/route?${params}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Route request failed: ${res.status}`);
  return res.json();
}

export function decodeShape(shape: string): { lat: number; lng: number }[] {
  // Valhalla кодирует с precision 6, не 5 как Google
  return polyline.decode(shape, 6).map(([lat, lng]) => ({ lat, lng }));
}

// Google Directions' overview_polyline is precision 5 — a DIFFERENT encoding
// from Valhalla's precision 6 used everywhere else in this app (decodeShape
// above). Never pass a Google shape to decodeShape or vice versa; the points
// come out silently wrong (not an error) because both are valid polyline
// encodings, just with a different scale factor.
export function decodeGoogleShape(shape: string): { lat: number; lng: number }[] {
  return polyline.decode(shape, 5).map(([lat, lng]) => ({ lat, lng }));
}

export interface GeocodeResult {
  name: string;
  lat: number;
  lng: number;
  formatted_address: string;
}

export async function geocode(query: string): Promise<GeocodeResult> {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`${API_URL}/geocode?${params}`, { credentials: 'include' });

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
  const res = await fetch(`${API_URL}/reverse-geocode?${params}`, { credentials: 'include' });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Reverse geocode request failed: ${res.status}`);
  }

  return res.json();
}

export interface StopsRequest {
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  categories: string[];
  max_detour_s: 900 | 1800 | 2700 | 3600;
  radius_m?: number;
  limit?: number;
  pace?: 'relaxed' | 'balanced' | 'packed';
}

export interface ApiStop {
  id: number;
  name: string;
  category: string;
  rating: number | null;
  review_count: number | null;
  // Free-text description, up to ~4400 chars in the source data — truncate for
  // display, never render raw. website/duration are equally unnormalized: duration
  // mixes formats ("3h", "2-3 hours", "2–3 hours" (en dash), "More than 3 hours",
  // "< 1 hour") — render as-is, do not attempt to parse it.
  about: string | null;
  website: string | null;
  duration: string | null;
  lat: number;
  lon: number;
  // Single-stop detour estimate relative to the direct route — NOT additive across
  // stops sharing a road (see delta_s on RouteThroughResult), so the UI must never
  // present this as a summand (no leading "+"); use formatDetour's phrasing.
  detour_s: number;
  to_poi_s: number;
  from_poi_s: number;
  suggested: boolean;
  // 0 or 1 for a round-trip option's stops (which leg it's on — see the
  // backend's services.stops.find_stops_for_round_trip); null for a one-way
  // option, which has no legs to distinguish.
  leg: number | null;
}

export interface UnreachablePoi {
  id: number;
  name: string;
}

export interface StopsResult {
  baseline_s: number;
  route_shape: string;
  candidates_found: number;
  stops: ApiStop[];
  unreachable: UnreachablePoi[];
  near_endpoints: UnreachablePoi[];
}

export async function getStops(req: StopsRequest): Promise<StopsResult> {
  const res = await fetch(`${API_URL}/stops`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      origin: req.origin,
      destination: req.destination,
      categories: req.categories,
      max_detour_s: req.max_detour_s,
      radius_m: req.radius_m ?? 20000,
      limit: req.limit ?? 50,
      pace: req.pace ?? 'balanced',
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Stops request failed: ${res.status}`);
  }

  return res.json();
}

export interface RouteThroughRequest {
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  // One-way: `stops`, ordered. Round-trip: `round_trip: true` plus
  // `leg1_stops`/`leg2_stops` instead (destination is the loop's pivot X) —
  // `stops` stays omitted/empty in that case.
  stops: { lat: number; lon: number }[];
  round_trip?: boolean;
  leg1_stops?: { lat: number; lon: number }[];
  leg2_stops?: { lat: number; lon: number }[];
}

export interface RouteLeg {
  from_index: number;
  to_index: number;
  duration_s: number;
  distance_km: number;
}

export interface RouteThroughResult {
  total_s: number;
  distance_km: number;
  route_shape: string;
  legs: RouteLeg[];
  baseline_s: number;
  delta_s: number;
}

export async function postRouteThrough(
  req: RouteThroughRequest,
  signal?: AbortSignal
): Promise<RouteThroughResult> {
  const res = await fetch(`${API_URL}/route-through`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(req),
    signal,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Route-through request failed: ${res.status}`);
  }

  return res.json();
}

export interface CompareRoutesRequest {
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  categories: string[];
  max_detour_s: 900 | 1800 | 2700 | 3600;
  pace?: 'relaxed' | 'balanced' | 'packed';
  alternates?: number;
  radius_m?: number;
  limit?: number;
  // True treats `destination` as the round trip's pivot X (A->X->A).
  round_trip?: boolean;
}

export interface TopStop {
  id: number;
  name: string;
  category: string;
  rating: number | null;
  review_count: number | null;
  detour_s: number;
}

export interface RouteOption {
  index: number;
  duration_s: number;
  distance_km: number;
  route_shape: string;
  // Route through this option's suggested stops. null only if build_route_through
  // failed for this option server-side — the rest of the option's stats still apply.
  through_shape: string | null;
  total_s: number | null;
  delta_s: number | null;
  stops: ApiStop[];
  candidates_found: number;
  avg_rating: number | null;
  top_stops: TopStop[];
  near_endpoints: UnreachablePoi[];
  unreachable: UnreachablePoi[];
}

export interface CompareRoutesResult {
  options: RouteOption[];
}

export async function getCompareRoutes(req: CompareRoutesRequest): Promise<CompareRoutesResult> {
  const res = await fetch(`${API_URL}/compare-routes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      origin: req.origin,
      destination: req.destination,
      categories: req.categories,
      max_detour_s: req.max_detour_s,
      pace: req.pace ?? 'balanced',
      alternates: req.alternates ?? 2,
      radius_m: req.radius_m ?? 20000,
      limit: req.limit ?? 50,
      round_trip: req.round_trip ?? false,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Compare routes request failed: ${res.status}`);
  }

  return res.json();
}

export interface DetailRouteRequest {
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  stops: { lat: number; lon: number }[];
  // Mapped client-side from the quiz's "drive" answer (quizMapping.ts::
  // mapDriveToDailyLimitS) — the backend never parses quiz text. Omit to fall
  // back to the backend's own default (28800s / 8h).
  daily_limit_s?: number;
  visit_s?: number;
  // Purely for the fits_plan comparison in the response — never changes the
  // route or the split itself.
  planned_days?: number | null;
  flexible_days?: boolean;
}

export interface DetailRouteLeg {
  duration_s: number;
  distance_km: number;
}

export interface DayResult {
  day: number;
  stop_indices: number[];
  drive_s: number;
  // Flat estimate (visit_s per stop assigned to this day), not measured —
  // see DetailRouteResult.days below for why the tilde in the UI matters.
  visit_s: number;
  total_s: number;
  over_limit: boolean;
}

export interface DetailRouteResult {
  // Exact numbers from Google Directions — NOT an estimate, unlike duration_s/
  // delta_s everywhere else in this app (those come from Valhalla, which runs
  // ~30-46% over real-world driving time). Never subtract one of these from a
  // Valhalla-sourced number, or vice versa — the difference is meaningless
  // because the two engines don't agree on a baseline.
  duration_s: number;
  distance_km: number;
  // Google's overview_polyline — precision 5. Decode with decodeGoogleShape,
  // never the shared decodeShape (precision 6, Valhalla-only).
  shape: string;
  legs: DetailRouteLeg[];
  baseline_s: number;
  delta_s: number;
  // Day split: drive_s per day is exact (Google), visit_s is a flat 1h/stop
  // estimate — total_s therefore mixes measured and estimated time. Render
  // day totals with a tilde ("~6 ч"), never as a bare number.
  days: DayResult[];
  planned_days: number | null;
  actual_days: number;
  fits_plan: boolean | null;
}

export async function postDetailRoute(req: DetailRouteRequest): Promise<DetailRouteResult> {
  const res = await fetch(`${API_URL}/detail-route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Detail route request failed: ${res.status}`);
  }

  return res.json();
}

export interface EnrichStopRequest {
  id: number;
  name: string;
  category: string;
  rating: number | null;
  review_count: number | null;
  detour_s: number;
  duration_raw: string | null;
  about: string | null;
  website: string | null;
}

export interface EnrichRouteRequest {
  origin_name: string;
  destination_name: string;
  trip_dates: string | null;
  total_duration_s: number;
  baseline_duration_s: number;
  delta_s: number;
  distance_km: number;
  stops: EnrichStopRequest[];
}

export interface EnrichedStop {
  id: number;
  // Everything below is LLM-authored text, not a computed number — the backend
  // (enrichment.py) is instructed to never invent its own time/distance/detour
  // figures, only reference the ones already in the request. Render this content
  // visually distinct from the router-derived stats (see PlanPanel's style note).
  why: string;
  tips: string | null;
  dates_note: string | null;
}

export interface EnrichSource {
  url: string;
  title: string;
}

export interface EnrichRouteResult {
  overview: string;
  stops: EnrichedStop[];
  warnings: string[];
  // Flat list of everything google_search grounded on for this route — not
  // attributed to individual stops. Per-stop attribution used to be done by
  // byte-offset containment into the raw JSON text, which broke outright once
  // grounding started cutting cited spans out of that text (see enrichment.py).
  sources: EnrichSource[];
}

export async function postEnrichRoute(req: EnrichRouteRequest): Promise<EnrichRouteResult> {
  const res = await fetch(`${API_URL}/enrich-route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Enrich route request failed: ${res.status}`);
  }

  return res.json();
}

export interface WhoAmIResult {
  session_id: string;
  is_new: boolean;
  last_seen_at: string;
}

// Establishes/extends the anonymous session (rtp_session cookie) — see
// sessions.py. credentials: 'include' is what actually lets the browser send
// and store that cookie through the /api proxy; without it this call would
// silently mint a brand-new session on every request.
export async function getWhoAmI(): Promise<WhoAmIResult> {
  const res = await fetch(`${API_URL}/session/whoami`, { credentials: 'include' });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Whoami request failed: ${res.status}`);
  }

  return res.json();
}

export interface LatLonReq {
  lat: number;
  lon: number;
}

export interface SaveTripRequest {
  trip_project_id: string | null;
  title: string | null;
  origin_name: string | null;
  destination_name: string | null;
  origin: LatLonReq | null;
  destination: LatLonReq | null;
  // Opaque snapshots — see TripProject.draft_state for what belongs in
  // draft_state (and what deliberately doesn't: no Google/Gemini detail).
  quiz_answers: Record<string, unknown> | null;
  draft_state: Record<string, unknown> | null;
}

export interface SaveTripResult {
  trip_project_id: string;
  updated_at: string;
}

export async function saveTrip(req: SaveTripRequest): Promise<SaveTripResult> {
  const res = await fetch(`${API_URL}/trips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Save trip failed: ${res.status}`);
  }

  return res.json();
}

export interface TripProject {
  id: string;
  title: string | null;
  origin_name: string | null;
  destination_name: string | null;
  origin: LatLonReq | null;
  destination: LatLonReq | null;
  status: string;
  quiz_answers: Record<string, unknown> | null;
  // Free-tier snapshot only (Valhalla route options, stops, per-option
  // inclusion/through-route state) — never Google detail-route or Gemini
  // enrichment results. Those are billable and belong to Finalize (Phase 2),
  // not an autosaved draft; day_split is cheap enough to just recompute
  // client-side from the restored legs instead of caching it here.
  draft_state: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export async function getCurrentTrip(): Promise<TripProject | null> {
  const res = await fetch(`${API_URL}/trips/current`, { credentials: 'include' });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Get current trip failed: ${res.status}`);
  }

  return res.json();
}

export async function getTrip(id: string): Promise<TripProject> {
  const res = await fetch(`${API_URL}/trips/${id}`, { credentials: 'include' });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Get trip failed: ${res.status}`);
  }

  return res.json();
}

export interface TripSummary {
  id: string;
  title: string | null;
  origin_name: string | null;
  destination_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

// "Мои поездки" — requires auth (401 if not signed in), lists ALL of the
// current user's trip_projects, not just the most recent draft like
// getCurrentTrip does. Deliberately no draft_state/quiz_answers on these
// rows — getTrip(id) fetches the full project only once a specific one is
// actually opened.
export async function getMyTrips(): Promise<TripSummary[]> {
  const res = await fetch(`${API_URL}/trips`, { credentials: 'include' });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Get my trips failed: ${res.status}`);
  }

  return res.json();
}

export async function deleteTrip(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/trips/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Delete trip failed: ${res.status}`);
  }
}

export interface LoginResult {
  user_id: string;
  email: string;
  is_new_user: boolean;
  // Project ids the current anonymous session's owner-less drafts got
  // reassigned to (backend claim logic in auth.py) — the frontend doesn't
  // need to act on this list, the currently open trip just keeps autosaving
  // to the same trip_project_id it already had.
  claimed_project_ids: string[];
}

// `credential` is the ID token (JWT) Google Identity Services hands back via
// GoogleSignInButton's callback — the backend verifies it against Google's
// public keys (auth.py), this call never trusts it itself.
export async function loginWithGoogle(credential: string): Promise<LoginResult> {
  const res = await fetch(`${API_URL}/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ credential }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Google sign-in failed: ${res.status}`);
  }

  return res.json();
}

export interface MeResult {
  authenticated: boolean;
  user_id: string | null;
  email: string | null;
}

export async function getMe(): Promise<MeResult> {
  const res = await fetch(`${API_URL}/auth/me`, { credentials: 'include' });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Get me failed: ${res.status}`);
  }

  return res.json();
}

export async function logout(): Promise<void> {
  const res = await fetch(`${API_URL}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Logout failed: ${res.status}`);
  }
}

export interface CreditsResult {
  balance: number;
  // True exactly once, right after this user's first-ever completed
  // Finalize — see finalize.is_first_finalize's docstring on the backend for
  // why this is derived from trip_versions, not the credit ledger charge.
  is_first_finalize: boolean;
}

export async function getCredits(): Promise<CreditsResult> {
  const res = await fetch(`${API_URL}/credits`, { credentials: 'include' });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Get credits failed: ${res.status}`);
  }

  return res.json();
}

export interface DayEndPoint {
  lat: number;
  lon: number;
  near_stop_name: string | null;
}

export interface LodgingOption {
  place_id: string;
  name: string;
  lat: number;
  lon: number;
  rating: number | null;
  user_ratings_total: number | null;
  price_level: number | null;
  vicinity: string | null;
  maps_url: string;
  distance_m: number;
}

export interface PreviewDay {
  day: number;
  stop_indices: number[];
  drive_s: number;
  visit_s: number;
  total_s: number;
  over_limit: boolean;
  end_point: DayEndPoint;
  // Up to 5, ranked (see accommodations.rank_for_selection on the backend) —
  // always [] for the last day (no night follows it) and may be [] for an
  // earlier day too if nothing real was found nearby.
  lodging_options: LodgingOption[];
}

export interface FinalizePreviewResult {
  // Always true — these are Valhalla-estimated days, not yet Google's exact
  // ones (see PlanPanel's "(оценка)" labeling elsewhere). The paid finalize
  // step recomputes days on exact times; they can end up slightly different.
  preliminary: boolean;
  days: PreviewDay[];
  has_lodging: boolean;
  // >1 day and at least one night has a real option — App.tsx uses this to
  // decide whether to show the lodging picker at all or skip straight to
  // the paywall/confirm step.
  needs_selection: boolean;
}

// Free — never charges a credit. Called right after the auth gate, BEFORE
// the paywall/confirm screen, so the user sees the day split and lodging
// options before any credit is at stake.
export async function postFinalizePreview(tripId: string): Promise<FinalizePreviewResult> {
  const res = await fetch(`${API_URL}/trips/${tripId}/finalize-preview`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Finalize preview request failed: ${res.status}`);
  }

  return res.json();
}

export interface SelectedLodging {
  day: number;
  place_id: string;
  lat: number;
  lon: number;
  name: string;
  // Carried straight from the LodgingOption the user picked (already have
  // it from finalize-preview) so the finalized snapshot can show them
  // without needing to re-fetch from Places.
  rating: number | null;
  vicinity: string | null;
}

export interface FinalizeResult {
  job_id: string;
  status: string;
  trip_version_id: string | null;
  error: string | null;
}

// idempotencyKey is generated ONCE when the confirm screen opens (App.tsx),
// not per click/retry — the backend's start_finalization treats a replayed
// key as "return the existing job", so retrying a failed request with the
// SAME key is exactly the safe behavior a flaky network needs, never a
// double charge. selectedLodging is null when the user skipped the picker
// (or it was never shown, e.g. a 1-day trip) — the route then has no
// lodging waypoints at all, same as before this feature existed.
export async function postFinalizeTrip(
  tripId: string, idempotencyKey: string, selectedLodging: SelectedLodging[] | null
): Promise<FinalizeResult> {
  const res = await fetch(`${API_URL}/trips/${tripId}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    credentials: 'include',
    body: JSON.stringify({ selected_lodging: selectedLodging }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    // insufficient_credits (402) carries a structured detail — surfaced as a
    // plain string here, the paywall gate check earlier should have already
    // prevented reaching this in practice.
    const detail = body?.detail;
    const message = typeof detail === 'string' ? detail : detail?.error || `Finalize request failed: ${res.status}`;
    throw new Error(message);
  }

  return res.json();
}

export async function getFinalizeStatus(jobId: string): Promise<FinalizeResult> {
  const res = await fetch(`${API_URL}/finalize/${jobId}/status`, { credentials: 'include' });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Get finalize status failed: ${res.status}`);
  }

  return res.json();
}

export interface FinalizedEndpoint {
  name: string | null;
  lat: number;
  lon: number;
}

export interface FinalizedStop {
  id: number;
  name: string;
  category: string;
  rating: number | null;
  review_count: number | null;
  lat: number;
  lon: number;
  detour_s: number;
  // Same "LLM never invents route numbers" contract as EnrichedStop above —
  // these three are the only free-text fields here.
  why: string;
  tips: string | null;
  dates_note: string | null;
  // 0 or 1 for a round-trip snapshot's stops (which leg it's on); null for
  // one-way, or a snapshot finalized before this field existed.
  leg: number | null;
}

export interface FinalizedRoute {
  // Exact, from Google — never labeled "(оценка)" anywhere this is shown,
  // unlike the draft's Valhalla-estimated numbers (see PlanPanel).
  duration_s: number;
  distance_km: number;
  // Google precision-5 polyline — decode with decodeGoogleShape, never decodeShape.
  shape: string;
  legs: DetailRouteLeg[];
}

export interface FinalizedEnrichment {
  overview: string;
  warnings: string[];
  sources: EnrichSource[];
}

export interface FinalizedLodging {
  place_id: string;
  name: string;
  lat: number;
  lon: number;
  maps_url: string;
  rating: number | null;
  vicinity: string | null;
}

// Own shape rather than reusing DayResult (which the free draft's day
// grouping also uses) — a finalized day always carries a lodging field
// (an object or null), a concept the free draft never has.
export interface FinalizedDay extends DayResult {
  lodging: FinalizedLodging | null;
}

export interface DayPlan {
  // null when the quiz's day count wasn't provided.
  requested: number | null;
  actual: number;
  flexible: boolean;
  // True only when actual > requested AND flexible is false.
  over_plan: boolean;
}

export interface FinalizedTripResult {
  origin: FinalizedEndpoint;
  // For round_trip=true, this is the loop's pivot X, NOT where the trip
  // physically ends — the trip always ends back at `origin`.
  destination: FinalizedEndpoint;
  stops: FinalizedStop[];
  route: FinalizedRoute;
  days: FinalizedDay[];
  day_plan: DayPlan;
  enrichment: FinalizedEnrichment;
  trip_dates: string | null;
  finalized_at: string;
  is_first_finalize: boolean;
  // True for an A->X->A loop.
  round_trip: boolean;
}

// Self-contained — built entirely from trip_versions.snapshot on the backend,
// never draft_state (which may have kept changing since finalization). Same
// indistinguishable-404 ownership check as getTrip.
export async function getFinalizedTrip(tripId: string): Promise<FinalizedTripResult> {
  const res = await fetch(`${API_URL}/trips/${tripId}/finalized`, { credentials: 'include' });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail || `Get finalized trip failed: ${res.status}`);
  }

  return res.json();
}