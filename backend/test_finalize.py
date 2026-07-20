import asyncio
import json
import uuid
from unittest.mock import AsyncMock, patch

import pytest

import accommodations
import db
import directions
import enrichment
import finalize
from db import get_pool

pytestmark = pytest.mark.anyio


async def _make_user(conn, balance: int) -> uuid.UUID:
    row = await conn.fetchrow(
        """
        INSERT INTO app.users (email, auth_provider, provider_sub)
        VALUES ($1, 'google', $2)
        RETURNING id
        """,
        f"finalize-test-{uuid.uuid4()}@example.com", f"finalize-sub-{uuid.uuid4()}",
    )
    user_id = row["id"]
    await conn.execute(
        "INSERT INTO app.credit_accounts (user_id, balance) VALUES ($1, $2)", user_id, balance
    )
    return user_id


async def _make_trip(conn, user_id: uuid.UUID) -> uuid.UUID:
    row = await conn.fetchrow(
        """
        INSERT INTO app.trip_projects (owner_user_id, status, title)
        VALUES ($1, 'draft', 'Finalize test trip')
        RETURNING id
        """,
        user_id,
    )
    return row["id"]


def _fake_stop(id_: int, to_poi_s: int) -> dict:
    return {
        "id": id_,
        "name": f"Stop {id_}",
        "category": "Nature & Parks",
        "rating": 4.5,
        "review_count": 120,
        "about": "A nice place.",
        "website": "https://example.com",
        "duration": "1-2 hours",
        "lat": 39.0 + id_ * 0.1,
        "lon": -105.0 - id_ * 0.1,
        "detour_s": 600,
        "to_poi_s": to_poi_s,
        "from_poi_s": 3600,
        "suggested": True,
    }


async def _make_trip_with_draft(conn, user_id: uuid.UUID) -> uuid.UUID:
    """A trip in the shape process_finalization's real pipeline expects to
    read: an active option with three stops (two included, out of to_poi_s
    order on purpose — the pipeline must sort them; one excluded, to prove
    it's filtered out), plus quiz_answers driving daily_limit_s/planned_days/
    flexible_days. No trip_dates in quiz_answers — matches production today,
    where nothing writes it there yet (see finalize.py's docstring)."""
    stop_included_a = _fake_stop(1, to_poi_s=3600)  # later along the route...
    stop_included_b = _fake_stop(2, to_poi_s=1800)  # ...but listed first here
    stop_excluded = _fake_stop(3, to_poi_s=2700)

    draft_state = {
        "version": 1,
        "options": [
            {
                "index": 0,
                "duration_s": 34000,
                "distance_km": 520.0,
                "route_shape": "fake_valhalla_shape",
                "through_shape": None,
                "total_s": None,
                "delta_s": None,
                "stops": [stop_included_a, stop_included_b, stop_excluded],
                "candidates_found": 3,
                "avg_rating": 4.5,
                "top_stops": [],
                "near_endpoints": [],
                "unreachable": [],
            }
        ],
        "activeOptionIndex": 0,
        "includedByOption": [[0, [1, 2]]],
        "routeThroughByOption": [],
        "routeOrigin": {"lat": 39.7392, "lng": -104.9903},
        "routeDest": {"lat": 37.2753, "lng": -107.8801},
    }
    quiz_answers = {"drive": "до 4 ч", "days": 3, "flexible_days": True}

    row = await conn.fetchrow(
        """
        INSERT INTO app.trip_projects
            (owner_user_id, status, title, origin_name, destination_name, quiz_answers, draft_state)
        VALUES ($1, 'draft', 'Finalize pipeline test trip', 'Денвер', 'Дуранго', $2::jsonb, $3::jsonb)
        RETURNING id
        """,
        user_id, json.dumps(quiz_answers), json.dumps(draft_state),
    )
    return row["id"]


def _fake_trip(draft_state: dict, quiz_answers: dict) -> dict:
    """In-memory trip dict, no DB — build_finalize_preview only reads its
    argument, never touches the database itself, so preview tests don't need
    the cleanup fixture or a real trip_projects row at all."""
    return {
        "id": uuid.uuid4(),
        "origin_name": "Денвер",
        "destination_name": "Дуранго",
        "quiz_answers": quiz_answers,
        "draft_state": draft_state,
    }


def _draft_state_with_stops(stops: list[dict], included_ids: list[int]) -> dict:
    return {
        "version": 1,
        "options": [{
            "index": 0, "duration_s": 30000, "distance_km": 400.0,
            "route_shape": "fake_shape", "through_shape": None, "total_s": None, "delta_s": None,
            "stops": stops, "candidates_found": len(stops), "avg_rating": None,
            "top_stops": [], "near_endpoints": [], "unreachable": [],
        }],
        "activeOptionIndex": 0,
        "includedByOption": [[0, included_ids]],
        "routeThroughByOption": [],
        "routeOrigin": {"lat": 39.7392, "lng": -104.9903},
        "routeDest": {"lat": 37.2753, "lng": -107.8801},
    }


_FAKE_ROUTE_DETAIL = {
    "duration_s": 36000,
    "distance_km": 550.5,
    "shape": "fake_google_shape",
    "legs": [
        {"duration_s": 18000, "distance_km": 275.0},
        {"duration_s": 18000, "distance_km": 275.5},
    ],
    "baseline_s": 34000,
    "delta_s": 2000,
    "days": [
        {"day": 1, "stop_indices": [0, 1], "drive_s": 36000, "visit_s": 7200, "total_s": 43200, "over_limit": False},
    ],
    "planned_days": 3,
    "actual_days": 1,
    "fits_plan": True,
}

_FAKE_ENRICH_RESULT = {
    "overview": "Отличная поездка через Скалистые горы.",
    "stops": [
        {"id": 1, "why": "Потрясающие виды", "tips": "Возьмите воду", "dates_note": None},
        {"id": 2, "why": "Историческое место", "tips": None, "dates_note": "Закрыто зимой"},
    ],
    "warnings": ["Проверьте состояние дорог"],
    "sources": [{"url": "https://example.com/source", "title": "Example Source"}],
}


@pytest.fixture
async def cleanup():
    """Same event-loop-per-test pool reset as test_auth.py's fixture (see its
    docstring), plus FK-ordered teardown for finalization_jobs/trip_versions:
    trip_projects cascades finalization_jobs away, but trip_versions and
    trip_projects.finalized_version_id reference each other, so trip_projects
    has to go first regardless."""
    db._pool = None
    created = {"trip_projects": [], "users": []}
    try:
        yield created
    finally:
        pool = await get_pool()
        async with pool.acquire() as conn:
            if created["trip_projects"]:
                await conn.execute(
                    "DELETE FROM app.trip_projects WHERE id = ANY($1::uuid[])", created["trip_projects"]
                )
                await conn.execute(
                    "DELETE FROM app.trip_versions WHERE trip_project_id = ANY($1::uuid[])",
                    created["trip_projects"],
                )
            if created["users"]:
                await conn.execute(
                    "DELETE FROM app.credit_ledger WHERE user_id = ANY($1::uuid[])", created["users"]
                )
                await conn.execute(
                    "DELETE FROM app.credit_accounts WHERE user_id = ANY($1::uuid[])", created["users"]
                )
                await conn.execute("DELETE FROM app.users WHERE id = ANY($1::uuid[])", created["users"])
        await pool.close()
        db._pool = None


async def test_finalize_charges_balance_and_creates_pending_job(cleanup):
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip(conn, user_id)
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

    job = await finalize.start_finalization(user_id, trip_id, idempotency_key=str(uuid.uuid4()))

    assert job.is_new is True
    assert job.status == "pending"

    pool = await get_pool()
    async with pool.acquire() as conn:
        balance = await conn.fetchval("SELECT balance FROM app.credit_accounts WHERE user_id = $1", user_id)
        assert balance == 0

        ledger = await conn.fetchrow(
            "SELECT amount, reason FROM app.credit_ledger WHERE user_id = $1 AND reason LIKE 'finalize:%'",
            user_id,
        )
        assert ledger["amount"] == -1
        assert ledger["reason"] == f"finalize:{trip_id}"

        project_status = await conn.fetchval("SELECT status FROM app.trip_projects WHERE id = $1", trip_id)
        assert project_status == "finalizing"

        job_status = await conn.fetchval("SELECT status FROM app.finalization_jobs WHERE id = $1", job.id)
        assert job_status == "pending"


async def test_finalize_with_zero_balance_charges_nothing(cleanup):
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=0)
        trip_id = await _make_trip(conn, user_id)
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

    with pytest.raises(finalize.InsufficientCreditsError) as exc_info:
        await finalize.start_finalization(user_id, trip_id, idempotency_key=str(uuid.uuid4()))
    assert exc_info.value.balance == 0

    pool = await get_pool()
    async with pool.acquire() as conn:
        balance = await conn.fetchval("SELECT balance FROM app.credit_accounts WHERE user_id = $1", user_id)
        assert balance == 0

        job_count = await conn.fetchval(
            "SELECT count(*) FROM app.finalization_jobs WHERE trip_project_id = $1", trip_id
        )
        assert job_count == 0

        # Untouched — never got past the balance check.
        project_status = await conn.fetchval("SELECT status FROM app.trip_projects WHERE id = $1", trip_id)
        assert project_status == "draft"


async def test_finalize_idempotent_replay_does_not_charge_twice(cleanup):
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip(conn, user_id)
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

    key = str(uuid.uuid4())
    first = await finalize.start_finalization(user_id, trip_id, idempotency_key=key)
    second = await finalize.start_finalization(user_id, trip_id, idempotency_key=key)

    assert first.is_new is True
    assert second.is_new is False
    assert second.id == first.id

    pool = await get_pool()
    async with pool.acquire() as conn:
        balance = await conn.fetchval("SELECT balance FROM app.credit_accounts WHERE user_id = $1", user_id)
        assert balance == 0  # charged once, not twice

        job_count = await conn.fetchval(
            "SELECT count(*) FROM app.finalization_jobs WHERE trip_project_id = $1", trip_id
        )
        assert job_count == 1


async def test_finalize_in_flight_different_key_reuses_existing_job(cleanup):
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip(conn, user_id)
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

    first = await finalize.start_finalization(user_id, trip_id, idempotency_key=str(uuid.uuid4()))
    # A DIFFERENT key — simulates a retry that didn't reuse the original one.
    # The first job is still 'pending' (nothing called process_finalization).
    second = await finalize.start_finalization(user_id, trip_id, idempotency_key=str(uuid.uuid4()))

    assert second.is_new is False
    assert second.id == first.id

    pool = await get_pool()
    async with pool.acquire() as conn:
        balance = await conn.fetchval("SELECT balance FROM app.credit_accounts WHERE user_id = $1", user_id)
        assert balance == 0  # still only charged once

        job_count = await conn.fetchval(
            "SELECT count(*) FROM app.finalization_jobs WHERE trip_project_id = $1", trip_id
        )
        assert job_count == 1


async def test_finalize_concurrent_calls_only_charge_once(cleanup):
    """Two genuinely concurrent finalize attempts on the SAME project,
    different idempotency keys, balance=1 — the trip_projects row lock in
    start_finalization should serialize them so only one charge happens and
    only one job gets created, whichever call wins the race."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip(conn, user_id)
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

    results = await asyncio.gather(
        finalize.start_finalization(user_id, trip_id, idempotency_key=str(uuid.uuid4())),
        finalize.start_finalization(user_id, trip_id, idempotency_key=str(uuid.uuid4())),
        return_exceptions=True,
    )

    for r in results:
        assert not isinstance(r, Exception), f"unexpected exception: {r!r}"

    job_ids = {r.id for r in results}
    assert len(job_ids) == 1  # only one job total, no matter which call created it

    pool = await get_pool()
    async with pool.acquire() as conn:
        balance = await conn.fetchval("SELECT balance FROM app.credit_accounts WHERE user_id = $1", user_id)
        assert balance == 0  # charged exactly once, not twice

        job_count = await conn.fetchval(
            "SELECT count(*) FROM app.finalization_jobs WHERE trip_project_id = $1", trip_id
        )
        assert job_count == 1


async def test_process_finalization_completes_with_real_pipeline(cleanup):
    """Google/Gemini themselves are mocked (no network, no cost) — everything
    else (draft_state parsing, stop filtering/sorting, dto assembly, snapshot
    assembly) is the real code path, exercised end to end."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip_with_draft(conn, user_id)
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

    job = await finalize.start_finalization(user_id, trip_id, idempotency_key=str(uuid.uuid4()))

    with patch("directions.get_route_detail", new=AsyncMock(return_value=_FAKE_ROUTE_DETAIL)), \
         patch("enrichment.enrich_route", new=AsyncMock(return_value=_FAKE_ENRICH_RESULT)):
        await finalize.process_finalization(job.id)

    pool = await get_pool()
    async with pool.acquire() as conn:
        job_row = await conn.fetchrow(
            "SELECT status, trip_version_id FROM app.finalization_jobs WHERE id = $1", job.id
        )
        assert job_row["status"] == "done"
        assert job_row["trip_version_id"] is not None

        version_row = await conn.fetchrow(
            "SELECT version_type, snapshot FROM app.trip_versions WHERE id = $1", job_row["trip_version_id"]
        )
        assert version_row["version_type"] == "finalized"
        snapshot = json.loads(version_row["snapshot"])

        assert snapshot["origin"] == {"name": "Денвер", "lat": 39.7392, "lon": -104.9903}
        assert snapshot["destination"] == {"name": "Дуранго", "lat": 37.2753, "lon": -107.8801}

        # Stop 3 was never included -> filtered out. Stop 2 (to_poi_s=1800)
        # comes before stop 1 (to_poi_s=3600) despite being listed after it
        # in draft_state -> proves the pipeline actually sorts.
        assert [s["id"] for s in snapshot["stops"]] == [2, 1]
        stop2 = snapshot["stops"][0]
        assert stop2["name"] == "Stop 2"
        assert stop2["why"] == "Историческое место"
        assert stop2["tips"] is None
        assert stop2["dates_note"] == "Закрыто зимой"
        stop1 = snapshot["stops"][1]
        assert stop1["why"] == "Потрясающие виды"
        assert stop1["tips"] == "Возьмите воду"

        assert snapshot["route"] == {
            "duration_s": 36000,
            "distance_km": 550.5,
            "shape": "fake_google_shape",
            "legs": _FAKE_ROUTE_DETAIL["legs"],
        }
        # No selected_lodging was passed to process_finalization -> every day
        # carries lodging=None, not just an absent key (uniform shape, see
        # finalize.py's snapshot_days comment).
        expected_days = [{**d, "lodging": None} for d in _FAKE_ROUTE_DETAIL["days"]]
        assert snapshot["days"] == expected_days
        assert snapshot["enrichment"] == {
            "overview": _FAKE_ENRICH_RESULT["overview"],
            "warnings": _FAKE_ENRICH_RESULT["warnings"],
            "sources": _FAKE_ENRICH_RESULT["sources"],
        }
        assert snapshot["trip_dates"] is None  # not in quiz_answers, per spec
        assert "finalized_at" in snapshot

        project_row = await conn.fetchrow(
            "SELECT status, finalized_version_id FROM app.trip_projects WHERE id = $1", trip_id
        )
        assert project_row["status"] == "finalized"
        assert project_row["finalized_version_id"] == job_row["trip_version_id"]


async def test_process_finalization_refunds_when_google_fails(cleanup):
    """A stop with no road access (ZERO_RESULTS-style) — directions.py raises
    DirectionsError, uncaught, and process_finalization must refund rather
    than silently mis-route (see finalize.py's docstring — Box Canyon)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip_with_draft(conn, user_id)
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

    job = await finalize.start_finalization(user_id, trip_id, idempotency_key=str(uuid.uuid4()))

    with patch(
        "directions.get_route_detail",
        new=AsyncMock(side_effect=directions.DirectionsError("Google Directions: ZERO_RESULTS")),
    ):
        await finalize.process_finalization(job.id)

    pool = await get_pool()
    async with pool.acquire() as conn:
        job_row = await conn.fetchrow(
            "SELECT status, error FROM app.finalization_jobs WHERE id = $1", job.id
        )
        assert job_row["status"] == "failed"
        assert "ZERO_RESULTS" in job_row["error"]

        balance = await conn.fetchval("SELECT balance FROM app.credit_accounts WHERE user_id = $1", user_id)
        assert balance == 1  # refunded

        project_status = await conn.fetchval("SELECT status FROM app.trip_projects WHERE id = $1", trip_id)
        assert project_status == "draft"


async def test_process_finalization_refunds_when_enrichment_fails(cleanup):
    """Google succeeds, Gemini doesn't — enrichment.EnrichmentError, also
    uncaught, must also refund."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip_with_draft(conn, user_id)
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

    job = await finalize.start_finalization(user_id, trip_id, idempotency_key=str(uuid.uuid4()))

    with patch("directions.get_route_detail", new=AsyncMock(return_value=_FAKE_ROUTE_DETAIL)), \
         patch("enrichment.enrich_route", new=AsyncMock(side_effect=enrichment.EnrichmentError("Gemini timeout"))):
        await finalize.process_finalization(job.id)

    pool = await get_pool()
    async with pool.acquire() as conn:
        job_row = await conn.fetchrow(
            "SELECT status, error FROM app.finalization_jobs WHERE id = $1", job.id
        )
        assert job_row["status"] == "failed"
        assert "Gemini timeout" in job_row["error"]

        balance = await conn.fetchval("SELECT balance FROM app.credit_accounts WHERE user_id = $1", user_id)
        assert balance == 1  # refunded

        ledger_refund = await conn.fetchrow(
            "SELECT amount, reason FROM app.credit_ledger WHERE user_id = $1 AND reason LIKE 'refund:%'",
            user_id,
        )
        assert ledger_refund["amount"] == 1
        assert ledger_refund["reason"] == f"refund:{trip_id}"

        project_status = await conn.fetchval("SELECT status FROM app.trip_projects WHERE id = $1", trip_id)
        assert project_status == "draft"


# --- Фаза ночёвок, подшаг 1: free preview (no DB, no credit) -----------------
# build_finalize_preview only reads the trip dict it's given — no cleanup
# fixture needed, nothing touches the database.

async def test_build_finalize_preview_ranks_lodging_and_marks_selection_needed():
    stop1 = _fake_stop(1, to_poi_s=1000)
    stop2 = _fake_stop(2, to_poi_s=2000)
    trip = _fake_trip(
        _draft_state_with_stops([stop1, stop2], included_ids=[1, 2]),
        quiz_answers={"drive": "до 4 ч", "detour": "до 30 мин"},
    )

    # Two stops, daily_limit_s=14400 (see quizMapping's "до 4 ч"): leg0+leg1
    # alone would push day 1 over the limit if stop2 were added to it, so
    # day_split must split after stop1 -> two days, exactly the boundary
    # this test needs to exercise lodging insertion at.
    fake_through = {
        "legs": [
            {"duration_s": 10000, "distance_km": 50.0},
            {"duration_s": 10000, "distance_km": 50.0},
            {"duration_s": 5000, "distance_km": 20.0},
        ],
        "total_s": 25000, "distance_km": 120.0, "route_shape": "valhalla_shape",
    }
    unrated = {"place_id": "p_unrated", "name": "Unrated Camp", "lat": 0, "lon": 0,
               "rating": None, "user_ratings_total": None, "price_level": None,
               "vicinity": "middle of nowhere", "maps_url": "url_unrated", "distance_m": 500}
    low_rated = {"place_id": "p_low", "name": "Low Rated Inn", "lat": 0, "lon": 0,
                 "rating": 3.2, "user_ratings_total": 10, "price_level": 1,
                 "vicinity": "town", "maps_url": "url_low", "distance_m": 1000}
    high_rated = {"place_id": "p_high", "name": "High Rated Lodge", "lat": 0, "lon": 0,
                  "rating": 4.8, "user_ratings_total": 300, "price_level": 3,
                  "vicinity": "town center", "maps_url": "url_high", "distance_m": 2000}

    with patch("services.stops.build_route_through", new=AsyncMock(return_value=fake_through)), \
         patch("accommodations.find_nearest_lodging", new=AsyncMock(return_value=[unrated, low_rated, high_rated])) as mock_lodging:
        preview = await finalize.build_finalize_preview(trip)

    assert preview["preliminary"] is True
    assert len(preview["days"]) == 2

    day1 = preview["days"][0]
    assert day1["stop_indices"] == [0]
    assert day1["end_point"] == {"lat": stop1["lat"], "lon": stop1["lon"], "near_stop_name": "Stop 1"}
    # Two reliable (>=10 reviews) candidates exist (low_rated, high_rated) ->
    # rank_for_selection's quality filter kicks in and drops the unrated one
    # entirely, ordering the rest by Bayes score, not raw rating. Ranking
    # edge cases themselves are covered exhaustively in test_accommodations.py
    # — this just confirms build_finalize_preview wires rank_for_selection in.
    assert [o["place_id"] for o in day1["lodging_options"]] == ["p_high", "p_low"]

    day2 = preview["days"][1]
    assert day2["stop_indices"] == [1]
    assert day2["end_point"] == {"lat": 37.2753, "lon": -107.8801, "near_stop_name": None}
    # Last day never gets a lodging search — no night follows it.
    assert day2["lodging_options"] == []

    assert preview["has_lodging"] is True
    assert preview["needs_selection"] is True

    # Radius comes from the quiz's "detour" answer (до 30 мин = 1800s),
    # converted at 1000/60 m per second -> 30000m; limit=20 candidates
    # fetched so ranking has enough to work with before slicing to 5.
    mock_lodging.assert_called_once_with(stop1["lat"], stop1["lon"], 30000, limit=20)


async def test_build_finalize_preview_single_day_skips_lodging_search():
    stop1 = _fake_stop(1, to_poi_s=1000)
    trip = _fake_trip(
        _draft_state_with_stops([stop1], included_ids=[1]),
        quiz_answers={"drive": "до 4 ч"},
    )
    fake_through = {
        "legs": [
            {"duration_s": 5000, "distance_km": 30.0},
            {"duration_s": 3000, "distance_km": 15.0},
        ],
        "total_s": 8000, "distance_km": 45.0, "route_shape": "valhalla_shape",
    }

    with patch("services.stops.build_route_through", new=AsyncMock(return_value=fake_through)), \
         patch("accommodations.find_nearest_lodging", new=AsyncMock()) as mock_lodging:
        preview = await finalize.build_finalize_preview(trip)

    assert len(preview["days"]) == 1
    assert preview["days"][0]["lodging_options"] == []
    assert preview["has_lodging"] is False
    assert preview["needs_selection"] is False
    mock_lodging.assert_not_called()


# --- Фаза ночёвок, подшаг 3: paid finalize with a lodging selection ---------

async def test_process_finalization_with_selected_lodging_inserts_waypoints(cleanup):
    """selected_lodging=[{day:1,...}] must land as a waypoint between day 1's
    stop and day 2's stop, with FIXED day boundaries (not re-discovered by
    day_split against the final Google times) and the snapshot's day 1
    carrying the chosen lodging, day 2 carrying None (last day, never picked)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip_with_draft(conn, user_id)
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

    # _make_trip_with_draft's stops are ids 1 (to_poi_s=3600) and 2
    # (to_poi_s=1800), both included -> sorted order is [2, 1]. Reuse it
    # rather than a third draft-building helper; day_split below only cares
    # about stop_count (2) and leg times, not which real stop is which.
    fake_through = {
        "legs": [
            {"duration_s": 10000, "distance_km": 50.0},
            {"duration_s": 10000, "distance_km": 50.0},
            {"duration_s": 5000, "distance_km": 20.0},
        ],
        "total_s": 25000, "distance_km": 120.0, "route_shape": "valhalla_shape",
    }
    fake_google_result = {
        "duration_s": 14000, "distance_km": 100.0, "shape": "google_shape_with_lodging",
        "legs": [
            {"duration_s": 2000, "distance_km": 10.0},
            {"duration_s": 3000, "distance_km": 15.0},
            {"duration_s": 4000, "distance_km": 20.0},
            {"duration_s": 5000, "distance_km": 25.0},
        ],
    }
    fake_baseline = {"duration_s": 12000, "distance_km": 90.0, "shape": "baseline_shape", "legs": []}

    calls: list[list] = []

    async def fake_get_directions(origin, destination, waypoints=None):
        calls.append(waypoints)
        return fake_google_result if waypoints else fake_baseline

    selected_lodging = [{
        "day": 1, "place_id": "lodge123", "lat": 39.15, "lon": -105.15, "name": "Mountain Inn",
        "rating": 4.6, "vicinity": "123 Alpine Way, Ouray",
    }]

    job = await finalize.start_finalization(user_id, trip_id, idempotency_key=str(uuid.uuid4()))

    with patch("services.stops.build_route_through", new=AsyncMock(return_value=fake_through)), \
         patch("directions.get_directions", new=AsyncMock(side_effect=fake_get_directions)), \
         patch("enrichment.enrich_route", new=AsyncMock(return_value=_FAKE_ENRICH_RESULT)):
        await finalize.process_finalization(job.id, selected_lodging)

    pool = await get_pool()
    async with pool.acquire() as conn:
        job_row = await conn.fetchrow(
            "SELECT status, trip_version_id FROM app.finalization_jobs WHERE id = $1", job.id
        )
        assert job_row["status"] == "done"

        version_row = await conn.fetchrow(
            "SELECT snapshot FROM app.trip_versions WHERE id = $1", job_row["trip_version_id"]
        )
        snapshot = json.loads(version_row["snapshot"])

    # Lodging coordinate inserted as the middle waypoint, between the two stops.
    routed_waypoints = calls[0]
    assert routed_waypoints[1] == (39.15, -105.15)
    assert len(routed_waypoints) == 3

    assert snapshot["route"]["shape"] == "google_shape_with_lodging"
    assert len(snapshot["days"]) == 2

    day1, day2 = snapshot["days"]
    assert day1["stop_indices"] == [0]
    assert day1["drive_s"] == 5000  # legs[0]+legs[1] = 2000+3000
    assert day1["total_s"] == 8600  # + visit_s 3600
    assert day1["lodging"] == {
        "place_id": "lodge123", "name": "Mountain Inn", "lat": 39.15, "lon": -105.15,
        "maps_url": "https://www.google.com/maps/place/?q=place_id:lodge123",
        "rating": 4.6, "vicinity": "123 Alpine Way, Ouray",
    }

    assert day2["stop_indices"] == [1]
    assert day2["drive_s"] == 9000  # legs[2]+legs[3] = 4000+5000 (final leg to dest included)
    assert day2["total_s"] == 12600
    assert day2["lodging"] is None

    pool = await get_pool()
    async with pool.acquire() as conn:
        # Money mechanics unaffected — one credit spent, nothing extra.
        balance = await conn.fetchval("SELECT balance FROM app.credit_accounts WHERE user_id = $1", user_id)
        assert balance == 0
        project_status = await conn.fetchval("SELECT status FROM app.trip_projects WHERE id = $1", trip_id)
        assert project_status == "finalized"
