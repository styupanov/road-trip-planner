import asyncio
import uuid
from datetime import datetime
from typing import Literal

import asyncpg
import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import routing
import geocoding
import directions
import enrichment
import sessions
import trips
import auth
import finalize
from services import stops as stops_service

app = FastAPI(title="Verified Road Trip Planner API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def read_root():
    return {"status": "alive", "service": "roadtrip-backend"}


@app.get("/health")
def health_check():
    return {"status": "ok"}


class WhoAmIResponse(BaseModel):
    session_id: uuid.UUID
    is_new: bool
    last_seen_at: datetime


@app.get("/session/whoami", response_model=WhoAmIResponse)
async def whoami(session: sessions.Session = Depends(sessions.get_session)):
    return WhoAmIResponse(session_id=session.id, is_new=session.is_new, last_seen_at=session.last_seen_at)


class GoogleAuthRequest(BaseModel):
    credential: str


class GoogleAuthResponse(BaseModel):
    user_id: uuid.UUID
    email: str
    is_new_user: bool
    claimed_project_ids: list[uuid.UUID]


@app.post("/auth/google", response_model=GoogleAuthResponse)
async def auth_google(req: GoogleAuthRequest, session: sessions.Session = Depends(sessions.get_session)):
    try:
        identity = auth.verify_google_token(req.credential)
    except auth.TokenVerificationError:
        raise HTTPException(status_code=401, detail="Невалидный токен Google.")

    result = await auth.claim_session_for_google_user(session.id, identity)
    return GoogleAuthResponse(
        user_id=result.user_id,
        email=result.email,
        is_new_user=result.is_new_user,
        claimed_project_ids=result.claimed_project_ids,
    )


class MeResponse(BaseModel):
    authenticated: bool
    user_id: uuid.UUID | None = None
    email: str | None = None


@app.get("/auth/me", response_model=MeResponse)
async def auth_me(session: sessions.Session = Depends(sessions.get_session)):
    if session.user_id is None:
        return MeResponse(authenticated=False)

    user = await auth.get_user(session.user_id)
    if user is None:
        # session.user_id doesn't resolve to a real row — shouldn't happen (FK
        # constraint), but fail safe as "not authenticated" rather than 500.
        return MeResponse(authenticated=False)

    return MeResponse(authenticated=True, user_id=user["id"], email=user["email"])


@app.post("/auth/logout")
async def auth_logout(response: Response):
    # Deliberately does NOT depend on the current session — logout doesn't
    # need to read it, only replace it. Depending on get_session here would
    # risk minting and then immediately discarding an extra anonymous session
    # (two Set-Cookie headers for one request) whenever the old cookie was
    # missing or invalid.
    await sessions.start_new_session(response)
    return {"status": "ok"}


@app.get("/route")
def route(start_lat: float, start_lon: float, end_lat: float, end_lon: float):
    return routing.get_route(start_lat, start_lon, end_lat, end_lon)


@app.get("/geocode")
def geocode(q: str):
    try:
        return geocoding.geocode(q)
    except geocoding.GeocodeNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/reverse-geocode")
def reverse_geocode(lat: float, lng: float):
    try:
        return geocoding.reverse_geocode(lat, lng)
    except geocoding.GeocodeNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


class LatLon(BaseModel):
    lat: float
    lon: float


class SaveTripRequest(BaseModel):
    trip_project_id: uuid.UUID | None = None
    title: str | None = None
    origin_name: str | None = None
    destination_name: str | None = None
    origin: LatLon | None = None
    destination: LatLon | None = None
    # Opaque JSON snapshots — this endpoint never looks inside them, just
    # stores/returns them verbatim. See draft_state's own comment on
    # TripProjectOut for what belongs in it (and what deliberately doesn't).
    quiz_answers: dict | None = None
    draft_state: dict | None = None


class SaveTripResponse(BaseModel):
    trip_project_id: uuid.UUID
    updated_at: datetime


class TripProjectOut(BaseModel):
    id: uuid.UUID
    title: str | None
    origin_name: str | None
    destination_name: str | None
    origin: LatLon | None
    destination: LatLon | None
    status: str
    quiz_answers: dict | None
    # Free-tier snapshot only (Valhalla route options, stops, per-option
    # inclusion/through-route state) — Google detail-route and Gemini
    # enrichment are NOT in here. Those are billable and belong to Finalize
    # (Phase 2), not an autosaved draft; day_split is cheap enough to just
    # recompute client-side from the restored legs instead of caching it here.
    draft_state: dict | None
    created_at: datetime
    updated_at: datetime


def _trip_row_to_out(row: dict) -> TripProjectOut:
    origin = (
        LatLon(lat=row["origin_lat"], lon=row["origin_lon"])
        if row["origin_lat"] is not None and row["origin_lon"] is not None
        else None
    )
    destination = (
        LatLon(lat=row["destination_lat"], lon=row["destination_lon"])
        if row["destination_lat"] is not None and row["destination_lon"] is not None
        else None
    )
    return TripProjectOut(
        id=row["id"],
        title=row["title"],
        origin_name=row["origin_name"],
        destination_name=row["destination_name"],
        origin=origin,
        destination=destination,
        status=row["status"],
        quiz_answers=row["quiz_answers"],
        draft_state=row["draft_state"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


@app.post("/trips", response_model=SaveTripResponse)
async def save_trip(req: SaveTripRequest, session: sessions.Session = Depends(sessions.get_session)):
    try:
        result = await trips.save_draft(
            session_id=session.id,
            trip_project_id=req.trip_project_id,
            title=req.title,
            origin_name=req.origin_name,
            destination_name=req.destination_name,
            origin=(req.origin.lat, req.origin.lon) if req.origin else None,
            destination=(req.destination.lat, req.destination.lon) if req.destination else None,
            quiz_answers=req.quiz_answers,
            draft_state=req.draft_state,
        )
    except trips.TripAccessError:
        raise HTTPException(status_code=403, detail="Этот черновик принадлежит другой сессии.")
    return SaveTripResponse(trip_project_id=result["id"], updated_at=result["updated_at"])


# Registered BEFORE /trips/{trip_id} — "current" would otherwise be swallowed
# by the dynamic path param and fail UUID parsing instead of matching here.
@app.get("/trips/current", response_model=TripProjectOut | None)
async def get_current_trip(session: sessions.Session = Depends(sessions.get_session)):
    row = await trips.get_current_draft(session.id)
    return _trip_row_to_out(row) if row else None


class TripSummaryOut(BaseModel):
    id: uuid.UUID
    title: str | None
    origin_name: str | None
    destination_name: str | None
    status: str
    created_at: datetime
    updated_at: datetime


# "Мои поездки" — requires a real account (owner_user_id), not just a
# session; an anonymous session only ever has "the current draft"
# (/trips/current above), there's no list for it. /trips (no id) also can't
# collide with /trips/{trip_id} below — different path shapes, no ordering
# dependency the way /trips/current had.
@app.get("/trips", response_model=list[TripSummaryOut])
async def list_my_trips(session: sessions.Session = Depends(sessions.get_session)):
    if session.user_id is None:
        raise HTTPException(status_code=401, detail="Требуется вход.")
    rows = await trips.list_trips_for_user(session.user_id)
    return [TripSummaryOut(**row) for row in rows]


@app.get("/trips/{trip_id}", response_model=TripProjectOut)
async def get_trip(trip_id: uuid.UUID, session: sessions.Session = Depends(sessions.get_session)):
    row = await trips.get_trip_for_session(session.id, session.user_id, trip_id)
    if row is None:
        # 404, never 403 — a project this caller doesn't own isn't something
        # to confirm the existence of.
        raise HTTPException(status_code=404, detail="Проект не найден.")
    return _trip_row_to_out(row)


@app.delete("/trips/{trip_id}")
async def delete_trip_endpoint(trip_id: uuid.UUID, session: sessions.Session = Depends(sessions.get_session)):
    # Same 404-not-401 reasoning as get_trip: an unauthenticated caller and a
    # non-owner are both just "can't delete this", not worth distinguishing.
    if session.user_id is None:
        raise HTTPException(status_code=404, detail="Проект не найден.")
    deleted = await trips.delete_trip(session.user_id, trip_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Проект не найден.")
    return {"status": "ok"}


class FinalizeRequest(BaseModel):
    # Frontend can send the key either as this field or as the Idempotency-Key
    # header (checked first below) — either is fine, one is required.
    idempotency_key: str | None = None


class FinalizeResponse(BaseModel):
    job_id: uuid.UUID
    status: str
    trip_version_id: uuid.UUID | None
    error: str | None


# Фаза 3, подшаг 1: charges 1 Trip Credit and starts a finalization_jobs row
# — see finalize.py's docstrings for the transaction/locking reasoning.
# process_finalization is a STUB right now (finalize.py's _build_stub_snapshot)
# — real detail-route/enrich-route/day_split wiring is подшаг 2, not this one.
@app.post("/trips/{trip_id}/finalize", response_model=FinalizeResponse)
async def finalize_trip(
    trip_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    req: FinalizeRequest = FinalizeRequest(),
    idempotency_key_header: str | None = Header(default=None, alias="Idempotency-Key"),
    session: sessions.Session = Depends(sessions.get_session),
):
    if session.user_id is None:
        raise HTTPException(status_code=401, detail="Требуется вход.")

    idempotency_key = idempotency_key_header or req.idempotency_key
    if not idempotency_key:
        raise HTTPException(status_code=400, detail="Idempotency-Key обязателен.")

    try:
        job = await finalize.start_finalization(
            user_id=session.user_id,
            trip_project_id=trip_id,
            idempotency_key=idempotency_key,
        )
    except finalize.TripNotFoundError:
        raise HTTPException(status_code=404, detail="Проект не найден.")
    except finalize.InsufficientCreditsError as e:
        raise HTTPException(
            status_code=402,
            detail={"error": "insufficient_credits", "balance": e.balance},
        )

    # Only schedule the background run for a job THIS call actually created —
    # scheduling it for a job returned via the idempotency/in-flight paths
    # would double-process it (see FinalizationJob.is_new's docstring).
    if job.is_new:
        background_tasks.add_task(finalize.process_finalization, job.id)

    return FinalizeResponse(job_id=job.id, status=job.status, trip_version_id=job.trip_version_id, error=job.error)


@app.get("/finalize/{job_id}/status", response_model=FinalizeResponse)
async def finalize_status(job_id: uuid.UUID, session: sessions.Session = Depends(sessions.get_session)):
    if session.user_id is None:
        raise HTTPException(status_code=401, detail="Требуется вход.")
    job = await finalize.get_job_status(session.user_id, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job не найден.")
    return FinalizeResponse(job_id=job_id, status=job.status, trip_version_id=job.trip_version_id, error=job.error)


class CreditsResponse(BaseModel):
    balance: int
    # True exactly once per user — right after their first-ever completed
    # Finalize. See finalize.is_first_finalize's docstring for why this is
    # derived from trip_versions, not the credit_ledger charge.
    is_first_finalize: bool


@app.get("/credits", response_model=CreditsResponse)
async def get_credits(session: sessions.Session = Depends(sessions.get_session)):
    if session.user_id is None:
        raise HTTPException(status_code=401, detail="Требуется вход.")
    balance = await finalize.get_balance(session.user_id)
    first = await finalize.is_first_finalize(session.user_id)
    return CreditsResponse(balance=balance, is_first_finalize=first)


class StopsRequest(BaseModel):
    origin: LatLon
    destination: LatLon
    categories: list[str]
    max_detour_s: Literal[900, 1800, 2700, 3600]
    radius_m: int = 20000
    limit: int = 50
    min_review_count: int = 20
    min_endpoint_distance_s: int | None = None
    pace: Literal["relaxed", "balanced", "packed"] = "balanced"


class StopOut(BaseModel):
    id: int
    name: str
    category: str
    rating: float | None
    review_count: int | None
    about: str | None
    website: str | None
    duration: str | None
    lat: float
    lon: float
    detour_s: int
    to_poi_s: int
    from_poi_s: int
    suggested: bool


class UnreachableOut(BaseModel):
    id: int
    name: str


class StopsResponse(BaseModel):
    baseline_s: int
    route_shape: str
    candidates_found: int
    stops: list[StopOut]
    unreachable: list[UnreachableOut]
    near_endpoints: list[UnreachableOut]
    min_endpoint_distance_s_used: int


@app.post("/stops", response_model=StopsResponse)
async def stops(req: StopsRequest):
    try:
        return await stops_service.find_stops(
            origin=(req.origin.lat, req.origin.lon),
            destination=(req.destination.lat, req.destination.lon),
            categories=req.categories,
            max_detour_s=req.max_detour_s,
            radius_m=req.radius_m,
            limit=req.limit,
            min_review_count=req.min_review_count,
            min_endpoint_distance_s=req.min_endpoint_distance_s,
            pace=req.pace,
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=502, detail=f"Valhalla routing error: {e.response.text}"
        )
    except httpx.RequestError:
        raise HTTPException(status_code=503, detail="Valhalla routing service unavailable")
    except (asyncpg.PostgresError, OSError):
        raise HTTPException(status_code=503, detail="Database unavailable")


class RouteThroughRequest(BaseModel):
    origin: LatLon
    destination: LatLon
    stops: list[LatLon]


class RouteLegOut(BaseModel):
    from_index: int
    to_index: int
    duration_s: int
    distance_km: float


class RouteThroughResponse(BaseModel):
    total_s: int
    distance_km: float
    route_shape: str
    legs: list[RouteLegOut]
    baseline_s: int
    delta_s: int


@app.post("/route-through", response_model=RouteThroughResponse)
async def route_through(req: RouteThroughRequest):
    origin = (req.origin.lat, req.origin.lon)
    destination = (req.destination.lat, req.destination.lon)
    stop_coords = [(s.lat, s.lon) for s in req.stops]

    try:
        baseline = await asyncio.to_thread(
            routing.get_route, origin[0], origin[1], destination[0], destination[1]
        )
        result = await stops_service.build_route_through(origin, destination, stop_coords)
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=502, detail=f"Valhalla routing error: {e.response.text}"
        )
    except httpx.RequestError:
        raise HTTPException(status_code=503, detail="Valhalla routing service unavailable")

    baseline_s = baseline["duration_seconds"]
    return {
        **result,
        "baseline_s": baseline_s,
        "delta_s": result["total_s"] - baseline_s,
    }


class DetailRouteRequest(BaseModel):
    origin: LatLon
    destination: LatLon
    stops: list[LatLon]
    # Soft daily driving ceiling, mapped client-side from the quiz's "drive"
    # answer (see quizMapping.ts::mapDriveToDailyLimitS) — the backend never
    # parses quiz text, same convention as max_detour_s/pace elsewhere in this
    # API.
    daily_limit_s: int = 28800
    visit_s: int = 3600
    # What the user asked for in the quiz, purely for the fits_plan comparison
    # below — the backend never uses this to alter the route or the split.
    planned_days: int | None = None
    flexible_days: bool = False


class DetailRouteLegOut(BaseModel):
    duration_s: int
    distance_km: float


class DayOut(BaseModel):
    day: int
    stop_indices: list[int]
    drive_s: int
    visit_s: int
    total_s: int
    over_limit: bool


class DetailRouteResponse(BaseModel):
    duration_s: int
    distance_km: float
    shape: str
    legs: list[DetailRouteLegOut]
    baseline_s: int
    delta_s: int
    days: list[DayOut]
    planned_days: int | None
    actual_days: int
    # None when the quiz's planned day count wasn't provided — there's nothing
    # to compare the split against, not even an unknown "false".
    fits_plan: bool | None


# Публичный доступ временный. This is a paid Finalize step (1 Trip Credit) by
# the monetization model — the frontend stopped calling it directly as of
# Фаза 1's final step (PlanPanel now has one "Финализировать поездку" button,
# not a free "Детализировать" one). In Фаза 3 this becomes an internal step
# of Finalize, gated behind ownership + credit checks; until then the route
# and its logic are unchanged on purpose, only reachable by a direct request.
@app.post("/detail-route", response_model=DetailRouteResponse)
async def detail_route(req: DetailRouteRequest):
    origin = (req.origin.lat, req.origin.lon)
    destination = (req.destination.lat, req.destination.lon)
    waypoints = [(s.lat, s.lon) for s in req.stops]

    try:
        return await directions.get_route_detail(
            origin, destination, waypoints,
            daily_limit_s=req.daily_limit_s,
            visit_s=req.visit_s,
            planned_days=req.planned_days,
            flexible_days=req.flexible_days,
        )
    except directions.DirectionsError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=502, detail=f"Google Directions error: {e.response.text}"
        )
    except httpx.RequestError:
        raise HTTPException(status_code=503, detail="Google Directions service unavailable")


class EnrichStopIn(BaseModel):
    id: int
    name: str
    category: str
    rating: float | None
    review_count: int | None
    detour_s: int
    duration_raw: str | None
    about: str | None
    website: str | None


class EnrichRouteRequest(BaseModel):
    origin_name: str
    destination_name: str
    trip_dates: str | None = None
    total_duration_s: int
    baseline_duration_s: int
    delta_s: int
    distance_km: float
    stops: list[EnrichStopIn]


class EnrichedStopOut(BaseModel):
    id: int
    why: str
    tips: str | None
    dates_note: str | None


class SourceOut(BaseModel):
    url: str
    title: str


class EnrichRouteResponse(BaseModel):
    overview: str
    stops: list[EnrichedStopOut]
    warnings: list[str]
    sources: list[SourceOut]


# Публичный доступ временный — see /detail-route's comment above, same
# situation: paid Finalize step, no longer called from the free frontend
# flow, becomes an internal Finalize step behind ownership + credit checks
# in Фаза 3. Route and enrichment.py itself are unchanged.
@app.post("/enrich-route", response_model=EnrichRouteResponse)
async def enrich_route_endpoint(req: EnrichRouteRequest):
    dto = stops_service.build_enrichment_dto(
        origin_name=req.origin_name,
        destination_name=req.destination_name,
        trip_dates=req.trip_dates,
        total_duration_s=req.total_duration_s,
        baseline_duration_s=req.baseline_duration_s,
        delta_s=req.delta_s,
        distance_km=req.distance_km,
        stops=[s.model_dump() for s in req.stops],
    )

    try:
        return await enrichment.enrich_route(dto)
    except enrichment.EnrichmentError as e:
        raise HTTPException(status_code=502, detail=str(e))


class FinalizedEndpointOut(BaseModel):
    name: str | None
    lat: float
    lon: float


class FinalizedStopOut(BaseModel):
    id: int
    name: str
    category: str
    rating: float | None
    review_count: int | None
    lat: float
    lon: float
    detour_s: int
    why: str
    tips: str | None
    dates_note: str | None


class FinalizedRouteOut(BaseModel):
    duration_s: int
    distance_km: float
    shape: str
    legs: list[DetailRouteLegOut]


class FinalizedEnrichmentOut(BaseModel):
    overview: str
    warnings: list[str]
    sources: list[SourceOut]


class FinalizedTripOut(BaseModel):
    origin: FinalizedEndpointOut
    destination: FinalizedEndpointOut
    stops: list[FinalizedStopOut]
    route: FinalizedRouteOut
    days: list[DayOut]
    enrichment: FinalizedEnrichmentOut
    trip_dates: str | None
    finalized_at: str
    is_first_finalize: bool


# Immutable, self-contained result of Finalize (подшаг 3) — built entirely
# from trip_versions.snapshot, never draft_state (which may have kept
# changing since). Same indistinguishable-404 ownership check as get_trip.
@app.get("/trips/{trip_id}/finalized", response_model=FinalizedTripOut)
async def get_finalized_trip(trip_id: uuid.UUID, session: sessions.Session = Depends(sessions.get_session)):
    snapshot = await finalize.get_finalized_snapshot(session.id, session.user_id, trip_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Финализированная версия не найдена.")
    first = await finalize.is_first_finalize(session.user_id) if session.user_id else False
    return FinalizedTripOut(**snapshot, is_first_finalize=first)


class CompareRoutesRequest(BaseModel):
    origin: LatLon
    destination: LatLon
    categories: list[str]
    max_detour_s: Literal[900, 1800, 2700, 3600]
    pace: Literal["relaxed", "balanced", "packed"] = "balanced"
    alternates: int = 2
    radius_m: int = 20000
    limit: int = 50


class TopStopOut(BaseModel):
    id: int
    name: str
    category: str
    rating: float | None
    review_count: int | None
    detour_s: int


class RouteOptionOut(BaseModel):
    index: int
    duration_s: int
    distance_km: float
    route_shape: str
    through_shape: str | None
    total_s: int | None
    delta_s: int | None
    stops: list[StopOut]
    candidates_found: int
    avg_rating: float | None
    top_stops: list[TopStopOut]
    near_endpoints: list[UnreachableOut]
    unreachable: list[UnreachableOut]


class CompareRoutesResponse(BaseModel):
    options: list[RouteOptionOut]


@app.post("/compare-routes", response_model=CompareRoutesResponse)
async def compare_routes(req: CompareRoutesRequest):
    try:
        return await stops_service.compare_routes(
            origin=(req.origin.lat, req.origin.lon),
            destination=(req.destination.lat, req.destination.lon),
            categories=req.categories,
            max_detour_s=req.max_detour_s,
            pace=req.pace,
            alternates=req.alternates,
            radius_m=req.radius_m,
            limit=req.limit,
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=502, detail=f"Valhalla routing error: {e.response.text}"
        )
    except httpx.RequestError:
        raise HTTPException(status_code=503, detail="Valhalla routing service unavailable")
    except (asyncpg.PostgresError, OSError):
        raise HTTPException(status_code=503, detail="Database unavailable")
