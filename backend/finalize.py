import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

import accommodations
import day_split
import directions
import enrichment
import trips
from db import get_pool
from services import stops as stops_service


class TripNotFoundError(Exception):
    """No trip with that id owned by this user — same indistinguishable-404
    reasoning used everywhere else in this app (trips.py): never confirm to
    the caller that a project exists but belongs to someone else."""


class InsufficientCreditsError(Exception):
    def __init__(self, balance: int):
        self.balance = balance
        super().__init__(f"insufficient credits: balance={balance}")


@dataclass
class FinalizationJob:
    id: uuid.UUID
    status: str
    trip_version_id: uuid.UUID | None
    error: str | None
    # False when this call returned an ALREADY-existing job (idempotency
    # replay, or another in-flight attempt on the same project) rather than
    # creating a new one — the caller (main.py) uses this to decide whether
    # to schedule process_finalization at all. Scheduling it for an existing
    # job would double-process it (two background tasks racing the same
    # pending -> processing -> done transition).
    is_new: bool


async def start_finalization(
    user_id: uuid.UUID,
    trip_project_id: uuid.UUID,
    idempotency_key: str,
) -> FinalizationJob:
    """Charges 1 Trip Credit and creates a finalization_jobs row, all in one
    transaction — a half-completed charge (credit gone, no job to show for
    it) would be strictly worse than the whole attempt failing and the
    frontend retrying.

    Two row locks, for two different races:
    - `trip_projects ... FOR UPDATE` serializes concurrent finalize attempts
      on the SAME project (two tabs, a double-click that didn't reuse the
      idempotency key) — the second call blocks here until the first
      commits, then sees the project already 'finalizing' and the in-flight
      job created by the first, instead of racing it to create a second job.
    - `credit_accounts ... FOR UPDATE` serializes concurrent attempts across
      ANY of this user's projects — what actually protects the balance from
      going negative under concurrent charges.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            trip_row = await conn.fetchrow(
                "SELECT id FROM app.trip_projects WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
                trip_project_id, user_id,
            )
            if trip_row is None:
                raise TripNotFoundError(str(trip_project_id))

            # Idempotency replay: identical (trip_project_id, idempotency_key)
            # already has a job — return it verbatim, charge nothing again.
            existing = await conn.fetchrow(
                """
                SELECT id, status, trip_version_id, error
                FROM app.finalization_jobs
                WHERE trip_project_id = $1 AND idempotency_key = $2
                """,
                trip_project_id, idempotency_key,
            )
            if existing is not None:
                return FinalizationJob(
                    id=existing["id"], status=existing["status"],
                    trip_version_id=existing["trip_version_id"], error=existing["error"],
                    is_new=False,
                )

            # Different idempotency key, but this project already has a job
            # actively being worked on — hand that back instead of starting
            # a second, parallel finalization (and a second charge) for it.
            in_flight = await conn.fetchrow(
                """
                SELECT id, status, trip_version_id, error
                FROM app.finalization_jobs
                WHERE trip_project_id = $1 AND status IN ('pending', 'processing')
                ORDER BY created_at DESC
                LIMIT 1
                """,
                trip_project_id,
            )
            if in_flight is not None:
                return FinalizationJob(
                    id=in_flight["id"], status=in_flight["status"],
                    trip_version_id=in_flight["trip_version_id"], error=in_flight["error"],
                    is_new=False,
                )

            account = await conn.fetchrow(
                "SELECT balance FROM app.credit_accounts WHERE user_id = $1 FOR UPDATE",
                user_id,
            )
            balance = account["balance"] if account is not None else 0
            if balance < 1:
                raise InsufficientCreditsError(balance)

            await conn.execute(
                "UPDATE app.credit_accounts SET balance = balance - 1 WHERE user_id = $1",
                user_id,
            )
            await conn.execute(
                "INSERT INTO app.credit_ledger (user_id, amount, reason) VALUES ($1, -1, $2)",
                user_id, f"finalize:{trip_project_id}",
            )

            job_row = await conn.fetchrow(
                """
                INSERT INTO app.finalization_jobs (trip_project_id, user_id, status, idempotency_key)
                VALUES ($1, $2, 'pending', $3)
                RETURNING id, status, trip_version_id, error
                """,
                trip_project_id, user_id, idempotency_key,
            )

            await conn.execute(
                "UPDATE app.trip_projects SET status = 'finalizing' WHERE id = $1",
                trip_project_id,
            )

    return FinalizationJob(
        id=job_row["id"], status=job_row["status"],
        trip_version_id=job_row["trip_version_id"], error=job_row["error"],
        is_new=True,
    )


class SnapshotBuildError(Exception):
    """draft_state has nothing buildable (no options, no active option, no
    routeOrigin/routeDest) — the trip never got far enough in `refine` for a
    real route to exist. Caught by process_finalization's own broad except
    exactly like a Google/Gemini failure — refund applies the same way."""


# Mirrors frontend/src/quizMapping.ts::mapDriveToDailyLimitS. Finalize runs
# entirely server-side (a background job, no request from the browser), so
# there's no client-mapped daily_limit_s to receive the way /detail-route
# gets one — the quiz's raw text answer has to be re-mapped here instead.
_DRIVE_TO_DAILY_LIMIT_S = {
    "до 3 ч": 10800,
    "до 4 ч": 14400,
    "до 6 ч": 21600,
    "не важно": 28800,
}
_DEFAULT_DAILY_LIMIT_S = 14400  # same default as quizMapping.ts, for "до 4 ч"


def _daily_limit_s_from_quiz(quiz_answers: dict | None) -> int:
    drive = (quiz_answers or {}).get("drive")
    if not isinstance(drive, str):
        return _DEFAULT_DAILY_LIMIT_S
    return _DRIVE_TO_DAILY_LIMIT_S.get(drive, _DEFAULT_DAILY_LIMIT_S)


# Mirrors frontend/src/quizMapping.ts::mapDetourToMaxDetourS — same reasoning
# as _daily_limit_s_from_quiz above, this time for the lodging preview
# (Фаза ночёвок, подшаг 1), which also runs server-side with only the quiz's
# raw text to work from.
_DETOUR_TO_MAX_DETOUR_S = {
    "до 15 мин": 900,
    "до 30 мин": 1800,
    "до 45 мин": 2700,
    "до часа": 3600,
}
_DEFAULT_MAX_DETOUR_S = 1800  # same default as quizMapping.ts, for "до 30 мин"


def _max_detour_s_from_quiz(quiz_answers: dict | None) -> int:
    detour = (quiz_answers or {}).get("detour")
    if not isinstance(detour, str):
        return _DEFAULT_MAX_DETOUR_S
    return _DETOUR_TO_MAX_DETOUR_S.get(detour, _DEFAULT_MAX_DETOUR_S)


# "1 minute of detour tolerance ~= 1 km of straight-line lodging search
# radius" — assumes ~60 km/h on the secondary/mountain roads typical near an
# overnight stop (slower than highway). There's no distance-equivalent
# anywhere in the quiz to convert from instead; this is a documented,
# easily-tunable assumption, not a measured conversion.
_METERS_PER_DETOUR_SECOND = 1000 / 60


def _lodging_radius_m_from_quiz(quiz_answers: dict | None) -> int:
    return round(_max_detour_s_from_quiz(quiz_answers) * _METERS_PER_DETOUR_SECOND)


def _parse_active_selection(trip: dict) -> tuple[tuple[float, float], tuple[float, float], list[dict]]:
    """Active option + its included stops (sorted by to_poi_s, same order
    the free 'plan' phase already sends to /route-through) from
    trip['draft_state'] — shared by the free preview
    (build_finalize_preview) and the paid pipeline (_build_finalized_snapshot),
    so both read draft_state exactly the same way and can never quietly drift
    apart on what "the selection" means.

    Raises SnapshotBuildError if there's nothing buildable yet (the trip
    never got far enough in `refine` for a real route to exist).
    """
    draft_state = trip["draft_state"] or {}
    options = draft_state.get("options") or []
    active_index = draft_state.get("activeOptionIndex")
    route_origin = draft_state.get("routeOrigin")
    route_dest = draft_state.get("routeDest")

    if (
        not isinstance(active_index, int)
        or not (0 <= active_index < len(options))
        or route_origin is None
        or route_dest is None
    ):
        raise SnapshotBuildError(f"trip project {trip['id']} has no buildable draft_state")

    active_option = options[active_index]
    stops_by_id = {s["id"]: s for s in active_option.get("stops") or []}

    included_ids: list[int] = []
    for pair in draft_state.get("includedByOption") or []:
        if pair[0] == active_index:
            included_ids = pair[1]
            break

    included_stops = sorted(
        (stops_by_id[sid] for sid in included_ids if sid in stops_by_id),
        key=lambda s: s["to_poi_s"],
    )

    origin = (route_origin["lat"], route_origin["lng"])
    destination = (route_dest["lat"], route_dest["lng"])
    return origin, destination, included_stops


async def build_finalize_preview(trip: dict) -> dict:
    """Free preview (Фаза ночёвок, подшаг 1): a Valhalla-estimated day split
    (same engine/precision as the free draft — see PlanPanel's "(оценка)"
    labeling) plus lodging options at each night's end point, BEFORE any
    credit is spent. Google Directions and Gemini are never called here —
    this is the screen that now sits in front of what used to be an
    immediate paid confirm step.

    Reuses services.stops.build_route_through (the same Valhalla route-
    through the free 'plan' phase already calls on every checkbox toggle)
    and day_split.split_into_days completely as-is — this function only
    feeds it real per-leg times and post-processes its output (end_point,
    lodging_options). day_split itself stays entirely unaware that lodging
    exists; see _build_route_detail_with_lodging's docstring for why that
    split is deliberate.
    """
    origin, destination, included_stops = _parse_active_selection(trip)
    stop_coords = [(s["lat"], s["lon"]) for s in included_stops]

    quiz_answers = trip["quiz_answers"] or {}
    daily_limit_s = _daily_limit_s_from_quiz(quiz_answers)
    radius_m = _lodging_radius_m_from_quiz(quiz_answers)

    through = await stops_service.build_route_through(origin, destination, stop_coords)
    days = day_split.split_into_days(
        through["legs"], stop_count=len(included_stops),
        daily_limit_s=daily_limit_s, visit_s=3600,
    )

    has_lodging = False
    last_day_num = days[-1]["day"] if days else None

    for day in days:
        is_last = day["day"] == last_day_num
        if is_last:
            end_point = {"lat": destination[0], "lon": destination[1], "near_stop_name": None}
        else:
            last_stop = included_stops[day["stop_indices"][-1]]
            end_point = {"lat": last_stop["lat"], "lon": last_stop["lon"], "near_stop_name": last_stop["name"]}
        day["end_point"] = end_point

        if is_last:
            # No overnight after the last day — nothing to search for.
            day["lodging_options"] = []
            continue

        try:
            candidates = await accommodations.find_nearest_lodging(
                end_point["lat"], end_point["lon"], radius_m, limit=20
            )
        except (accommodations.PlacesError, httpx.HTTPError):
            # A lodging-search hiccup for one night shouldn't sink the whole
            # free preview — the day split itself is still useful without it.
            candidates = []

        # rank_for_selection drops thin-review/unrated places ONLY when
        # enough reliable ones exist to fill the list — a remote corridor
        # with nothing but a two-review campground still gets that campground
        # shown, never an empty list (see its own docstring).
        options = accommodations.rank_for_selection(candidates)
        day["lodging_options"] = options
        if options:
            has_lodging = True

    return {
        "preliminary": True,
        "days": days,
        "has_lodging": has_lodging,
        # >1 day and at least one night has a real option — a 1-day trip (no
        # nights at all) or a corridor with nothing nearby anywhere both skip
        # straight to the paywall/confirm step, no empty picker shown.
        "needs_selection": len(days) > 1 and has_lodging,
    }


async def _build_route_detail_with_lodging(
    origin: tuple[float, float],
    destination: tuple[float, float],
    included_stops: list[dict],
    selected_lodging: list[dict],
    daily_limit_s: int,
    visit_s: int,
) -> dict:
    """Google-routed detail when the user picked lodging for one or more
    nights (Фаза ночёвок, подшаг 3). Waypoints become: day-1 stops,
    lodging-1, day-2 stops, lodging-2, ..., last-day stops — day boundaries
    are FIXED at each lodging pick, not discovered greedily. day_split.py
    stays entirely lodging-unaware by design: it has no concept of "this
    waypoint MUST end a day" (only "how much time is left"), so feeding it a
    mix of real stops and a chosen overnight would let it split wherever the
    clock says, possibly stranding the lodging pick mid-day instead of at
    the boundary the user actually chose. Fixed boundaries need different,
    simpler bookkeeping than that algorithm does — done inline below rather
    than bent into split_into_days' shape.

    The boundary POSITIONS (how many stops per day) come from re-running the
    exact same free preliminary Valhalla split build_finalize_preview showed
    the user, so selected_lodging[i]["day"] lines up with the same grouping
    they picked from. Every NUMBER in the returned days/legs is Google's,
    never Valhalla's — only where the boundaries fall is inherited from the
    free preview, not its timings. This means final day totals can differ
    slightly from what the preview showed (Valhalla -> Google, and the
    corridor could in principle have changed between preview and payment) —
    expected, not a bug, same as the existing Valhalla-vs-Google gap between
    the free draft and any finalized result.
    """
    lodging_by_day = {entry["day"]: entry for entry in selected_lodging}

    stop_coords = [(s["lat"], s["lon"]) for s in included_stops]
    through = await stops_service.build_route_through(origin, destination, stop_coords)
    prelim_days = day_split.split_into_days(
        through["legs"], stop_count=len(included_stops),
        daily_limit_s=daily_limit_s, visit_s=visit_s,
    )

    waypoints: list[tuple[float, float]] = []
    day_stop_counts: list[int] = []
    day_lodging: list[dict | None] = []
    for day in prelim_days:
        for idx in day["stop_indices"]:
            stop = included_stops[idx]
            waypoints.append((stop["lat"], stop["lon"]))
        day_stop_counts.append(len(day["stop_indices"]))

        lodging = lodging_by_day.get(day["day"])
        if lodging is not None:
            waypoints.append((lodging["lat"], lodging["lon"]))
        day_lodging.append(lodging)

    result = await directions.get_directions(origin, destination, waypoints)
    baseline = await directions.get_directions(origin, destination, None)

    days: list[dict] = []
    leg_cursor = 0
    stop_cursor = 0
    n_days = len(day_stop_counts)
    for i, (stop_count, lodging) in enumerate(zip(day_stop_counts, day_lodging)):
        # The final leg (last waypoint -> destination) belongs to whichever
        # day is last, same "closes wherever it lands" rule day_split.py
        # itself uses for the drive home.
        is_last_day = i == n_days - 1
        n_legs = stop_count + (1 if lodging is not None else 0) + (1 if is_last_day else 0)
        day_legs = result["legs"][leg_cursor: leg_cursor + n_legs]
        drive_s = sum(leg["duration_s"] for leg in day_legs)
        visit_total_s = visit_s * stop_count

        days.append({
            "day": i + 1,
            "stop_indices": list(range(stop_cursor, stop_cursor + stop_count)),
            "drive_s": drive_s,
            "visit_s": visit_total_s,
            "total_s": drive_s + visit_total_s,
            "over_limit": (drive_s + visit_total_s) > daily_limit_s,
            "lodging": lodging,
        })
        leg_cursor += n_legs
        stop_cursor += stop_count

    return {
        "duration_s": result["duration_s"],
        "distance_km": result["distance_km"],
        "shape": result["shape"],
        "legs": result["legs"],
        "baseline_s": baseline["duration_s"],
        "delta_s": result["duration_s"] - baseline["duration_s"],
        "days": days,
    }


async def _build_finalized_snapshot(
    trip_project_id: uuid.UUID, selected_lodging: list[dict] | None = None
) -> dict:
    """The real detailing pipeline (Фаза 3, подшаг 2; extended in Фаза
    ночёвок, подшаг 3, to route through selected lodging). Reads the trip's
    draft_state (active option, included stops) and quiz_answers via the
    same _parse_active_selection the free preview uses, then reuses
    directions.get_route_detail (real Google Directions + day_split, same
    function /detail-route delegates to) when no lodging was picked, or
    _build_route_detail_with_lodging (same Google Directions, fixed day
    boundaries) when it was — and enrichment.enrich_route (the two-call
    Gemini pipeline /enrich-route delegates to) either way. None of these
    are duplicated here, only orchestrated.

    Self-contained on purpose: every field the frontend needs to show a
    finalized trip is copied into the returned dict, not referenced by id —
    draft_state can keep changing after this runs without affecting a
    version already written from this snapshot.

    Raises SnapshotBuildError, directions.DirectionsError, an httpx
    transport/HTTP error, or enrichment.EnrichmentError — all uncaught on
    purpose, so process_finalization's own except Exception triggers the
    refund path for any of them (this includes Google ZERO_RESULTS for a
    stop with no road access, e.g. Box Canyon — known limitation, not fixed
    here, just fails honestly instead of silently mis-routing).
    """
    trip = await trips.get_trip_by_id(trip_project_id)
    if trip is None:
        raise SnapshotBuildError(f"trip project {trip_project_id} vanished before finalization")

    origin, destination, included_stops = _parse_active_selection(trip)

    quiz_answers = trip["quiz_answers"] or {}

    planned_days_raw = quiz_answers.get("days")
    planned_days = int(planned_days_raw) if isinstance(planned_days_raw, (int, float)) else None
    flexible_days = bool(quiz_answers.get("flexible_days"))
    daily_limit_s = _daily_limit_s_from_quiz(quiz_answers)

    trip_dates = quiz_answers.get("trip_dates")
    if not isinstance(trip_dates, str):
        trip_dates = None

    # Slow, paid external call #1 — deliberately outside any DB transaction
    # (see process_finalization's docstring). Raises on failure, uncaught.
    if selected_lodging:
        route_detail = await _build_route_detail_with_lodging(
            origin, destination, included_stops, selected_lodging,
            daily_limit_s=daily_limit_s, visit_s=3600,
        )
    else:
        waypoints = [(s["lat"], s["lon"]) for s in included_stops]
        route_detail = await directions.get_route_detail(
            origin, destination, waypoints,
            daily_limit_s=daily_limit_s,
            visit_s=3600,
            planned_days=planned_days,
            flexible_days=flexible_days,
        )

    enrich_dto = stops_service.build_enrichment_dto(
        origin_name=trip["origin_name"] or "",
        destination_name=trip["destination_name"] or "",
        trip_dates=trip_dates,
        total_duration_s=route_detail["duration_s"],
        baseline_duration_s=route_detail["baseline_s"],
        delta_s=route_detail["delta_s"],
        distance_km=route_detail["distance_km"],
        stops=[
            {
                "id": s["id"],
                "name": s["name"],
                "category": s["category"],
                "rating": s.get("rating"),
                "review_count": s.get("review_count"),
                "detour_s": s["detour_s"],
                "duration_raw": s.get("duration"),
                "about": s.get("about"),
                "website": s.get("website"),
            }
            for s in included_stops
        ],
    )

    # Slow, paid external call #2 — same "outside any transaction" reasoning.
    # Raises enrichment.EnrichmentError on failure, uncaught.
    enrich_result = await enrichment.enrich_route(enrich_dto)
    enrich_by_id = {s["id"]: s for s in enrich_result["stops"]}

    snapshot_stops = []
    for s in included_stops:
        e = enrich_by_id.get(s["id"])
        snapshot_stops.append({
            "id": s["id"],
            "name": s["name"],
            "category": s["category"],
            "rating": s.get("rating"),
            "review_count": s.get("review_count"),
            "lat": s["lat"],
            "lon": s["lon"],
            "detour_s": s["detour_s"],
            "why": e["why"] if e else "",
            "tips": e.get("tips") if e else None,
            "dates_note": e.get("dates_note") if e else None,
        })

    # Uniform day shape regardless of path taken above — "lodging" is always
    # present (dict or None), never a key that's just absent when nothing
    # was picked (no-lodging path's days, from directions.get_route_detail,
    # never had the key at all; .get() below covers that transparently).
    snapshot_days = []
    for day in route_detail["days"]:
        lodging = day.get("lodging")
        snapshot_days.append({
            "day": day["day"],
            "stop_indices": day["stop_indices"],
            "drive_s": day["drive_s"],
            "visit_s": day["visit_s"],
            "total_s": day["total_s"],
            "over_limit": day["over_limit"],
            "lodging": {
                "place_id": lodging["place_id"],
                "name": lodging["name"],
                "lat": lodging["lat"],
                "lon": lodging["lon"],
                "maps_url": f"https://www.google.com/maps/place/?q=place_id:{lodging['place_id']}",
                "rating": lodging.get("rating"),
                "vicinity": lodging.get("vicinity"),
            } if lodging else None,
        })

    # How the day-split ACTUALLY came out vs what the quiz asked for —
    # computed HERE, from the finished snapshot_days, not inside
    # get_route_detail/day_split. That's deliberate: get_route_detail's own
    # fits_plan only exists in the no-lodging branch above (and is never
    # read past this point — _build_route_detail_with_lodging doesn't even
    # accept planned_days/flexible_days as arguments), so it can't be the
    # source of truth for a feature that has to work the same way regardless
    # of whether lodging was picked. len(snapshot_days) is the one number
    # that's always available, from either path, after the real day-split
    # (Valhalla-boundary-driven or Google-fixed-boundary) has already run.
    actual_days = len(snapshot_days)
    over_plan = planned_days is not None and actual_days > planned_days and not flexible_days
    day_plan = {
        "requested": planned_days,
        "actual": actual_days,
        "flexible": flexible_days,
        "over_plan": over_plan,
    }

    return {
        "origin": {"name": trip["origin_name"], "lat": origin[0], "lon": origin[1]},
        "destination": {"name": trip["destination_name"], "lat": destination[0], "lon": destination[1]},
        "stops": snapshot_stops,
        "route": {
            "duration_s": route_detail["duration_s"],
            "distance_km": route_detail["distance_km"],
            "shape": route_detail["shape"],
            "legs": route_detail["legs"],
        },
        "days": snapshot_days,
        "day_plan": day_plan,
        "enrichment": {
            "overview": enrich_result["overview"],
            "warnings": enrich_result["warnings"],
            "sources": enrich_result["sources"],
        },
        "trip_dates": trip_dates,
        "finalized_at": datetime.now(timezone.utc).isoformat(),
    }


async def process_finalization(job_id: uuid.UUID, selected_lodging: list[dict] | None = None) -> None:
    """Background task (FastAPI BackgroundTasks) — runs after the charging
    transaction in start_finalization has already committed and the HTTP
    response has been sent. Three short transactions, not one long one
    spanning the "real work": that work will eventually be slow external API
    calls (Google/Gemini, подшаг 2), which have no business holding a DB
    transaction open.

    selected_lodging comes straight from the /trips/{id}/finalize request
    body (main.py) that scheduled this task — not persisted anywhere, purely
    passed through BackgroundTasks' own arguments. An idempotency replay or
    in-flight-job return never re-schedules this task (see FinalizationJob.
    is_new's docstring), so a request's selected_lodging only ever matters
    for the ONE call that actually created the job; the same is already true
    of idempotency_key today, this just extends it.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        job_row = await conn.fetchrow(
            "SELECT trip_project_id, user_id FROM app.finalization_jobs WHERE id = $1",
            job_id,
        )
        if job_row is None:
            return  # job vanished (shouldn't happen) — nothing to process
        trip_project_id = job_row["trip_project_id"]
        user_id = job_row["user_id"]

        await conn.execute(
            "UPDATE app.finalization_jobs SET status = 'processing' WHERE id = $1",
            job_id,
        )

    try:
        snapshot = await _build_finalized_snapshot(trip_project_id, selected_lodging)

        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                version_row = await conn.fetchrow(
                    """
                    INSERT INTO app.trip_versions (trip_project_id, version_type, snapshot)
                    VALUES ($1, 'finalized', $2::jsonb)
                    RETURNING id
                    """,
                    trip_project_id, json.dumps(snapshot),
                )
                version_id = version_row["id"]

                await conn.execute(
                    "UPDATE app.finalization_jobs SET status = 'done', trip_version_id = $1 WHERE id = $2",
                    version_id, job_id,
                )
                await conn.execute(
                    """
                    UPDATE app.trip_projects
                    SET status = 'finalized', finalized_version_id = $1
                    WHERE id = $2
                    """,
                    version_id, trip_project_id,
                )
    except Exception as e:
        # Paid, didn't deliver -> refund is mandatory, not best-effort. Own
        # transaction, separate from whatever failed above.
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "UPDATE app.finalization_jobs SET status = 'failed', error = $1 WHERE id = $2",
                    str(e), job_id,
                )
                await conn.execute(
                    "UPDATE app.credit_accounts SET balance = balance + 1 WHERE user_id = $1",
                    user_id,
                )
                await conn.execute(
                    "INSERT INTO app.credit_ledger (user_id, amount, reason) VALUES ($1, 1, $2)",
                    user_id, f"refund:{trip_project_id}",
                )
                await conn.execute(
                    "UPDATE app.trip_projects SET status = 'draft' WHERE id = $1",
                    trip_project_id,
                )


@dataclass
class JobStatus:
    status: str
    trip_version_id: uuid.UUID | None
    error: str | None


async def get_job_status(user_id: uuid.UUID, job_id: uuid.UUID) -> JobStatus | None:
    """None if the job doesn't exist or belongs to someone else — same
    indistinguishable-404 reasoning as everywhere else."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status, trip_version_id, error FROM app.finalization_jobs WHERE id = $1 AND user_id = $2",
            job_id, user_id,
        )
    return JobStatus(status=row["status"], trip_version_id=row["trip_version_id"], error=row["error"]) if row else None


async def get_balance(user_id: uuid.UUID) -> int:
    """Plain unlocked read, for display only — never used to decide whether a
    charge can proceed (start_finalization does its own FOR UPDATE read for
    that, unchanged from подшаг 1). 0 if the row doesn't exist rather than
    raising — shouldn't happen post-signup (claim_session_for_google_user
    always creates one), but a missing account reads the same as an empty one
    here, not an error."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        balance = await conn.fetchval(
            "SELECT balance FROM app.credit_accounts WHERE user_id = $1", user_id
        )
    return balance if balance is not None else 0


async def is_first_finalize(user_id: uuid.UUID) -> bool:
    """True if this user has exactly one finalized trip_version total, right
    now — gates the one-time "this one's on us" welcome modal (подшаг 3),
    shown once right after a user's first successful Finalize.

    Counts trip_versions, not credit_ledger's 'finalize:%' entries: a ledger
    charge happens on every attempt, including ones that later fail and get
    refunded, so it would overcount. A trip_versions row only ever exists for
    a run that actually completed — the right signal for "has this user ever
    seen a finished result before."
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        count = await conn.fetchval(
            """
            SELECT count(*) FROM app.trip_versions tv
            JOIN app.trip_projects tp ON tp.id = tv.trip_project_id
            WHERE tp.owner_user_id = $1 AND tv.version_type = 'finalized'
            """,
            user_id,
        )
    return count == 1


async def get_finalized_snapshot(
    session_id: uuid.UUID, user_id: uuid.UUID | None, trip_id: uuid.UUID
) -> dict | None:
    """None if the trip doesn't exist, doesn't belong to the caller (same
    session/owner check as trips.get_trip_for_session), or has never been
    finalized (finalized_version_id IS NULL) — same indistinguishable-404
    reasoning used everywhere else in this app: never confirm to the caller
    which of those three it was.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT tv.snapshot
            FROM app.trip_projects tp
            JOIN app.trip_versions tv ON tv.id = tp.finalized_version_id
            WHERE tp.id = $1 AND (tp.anonymous_session_id = $2 OR tp.owner_user_id = $3)
            """,
            trip_id, session_id, user_id,
        )
    return json.loads(row["snapshot"]) if row else None
