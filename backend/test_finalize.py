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
import trips
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


async def _make_trip_with_draft(conn, user_id: uuid.UUID, quiz_answers: dict | None = None) -> uuid.UUID:
    """A trip in the shape process_finalization's real pipeline expects to
    read: an active option with three stops (two included, out of to_poi_s
    order on purpose — the pipeline must sort them; one excluded, to prove
    it's filtered out), plus quiz_answers driving daily_limit_s/planned_days/
    flexible_days. No trip_dates in quiz_answers — matches production today,
    where nothing writes it there yet (see finalize.py's docstring).

    quiz_answers defaults to days=3/flexible_days=True (the original fixture,
    still used by tests that don't care about day_plan specifics) — pass an
    override for tests that need a specific requested/flexible combination.
    """
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
    if quiz_answers is None:
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


async def _make_anonymous_session(conn) -> uuid.UUID:
    """A real app.anonymous_sessions row — trip_projects.anonymous_session_id
    is a foreign key, so ownership tests exercising save_draft/start_finalization's
    session_id can't just pass an arbitrary uuid4() (see test_auth.py's own
    identical helper for the same reason)."""
    row = await conn.fetchrow("INSERT INTO app.anonymous_sessions DEFAULT VALUES RETURNING id")
    return row["id"]


@pytest.fixture
async def cleanup():
    """Same event-loop-per-test pool reset as test_auth.py's fixture (see its
    docstring), plus FK-ordered teardown for finalization_jobs/trip_versions:
    trip_projects cascades finalization_jobs away, but trip_versions and
    trip_projects.finalized_version_id reference each other, so trip_projects
    has to go first regardless. "sessions" mirrors test_auth.py's own cleanup
    — only populated by the ownership tests that need a real anonymous_sessions
    row (trip_projects.anonymous_session_id is a foreign key)."""
    db._pool = None
    created = {"trip_projects": [], "users": [], "sessions": []}
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
            if created["sessions"]:
                await conn.execute(
                    "DELETE FROM app.anonymous_sessions WHERE id = ANY($1::uuid[])", created["sessions"]
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

    job = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))

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
        await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))
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
    first = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=key)
    second = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=key)

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

    first = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))
    # A DIFFERENT key — simulates a retry that didn't reuse the original one.
    # The first job is still 'pending' (nothing called process_finalization).
    second = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))

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
        finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4())),
        finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4())),
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


# --- Ownership: save_draft assigns owner_user_id immediately for an
# already-logged-in session, and start_finalization's backfill safety net
# covers a project that somehow still ended up with owner_user_id NULL
# (e.g. created before this fix, or any other edge case) — but only ever
# when THIS request's own session proves it belongs to this user. See
# trips.py::save_draft and finalize.py::start_finalization's own comments.

async def test_save_draft_sets_owner_user_id_when_session_already_logged_in(cleanup):
    """The actual root-cause fix: a session that's ALREADY logged in at
    creation time must not rely on claim_session_for_google_user (which only
    fires on the /auth/google login event, never again afterwards) — save_draft
    itself must stamp owner_user_id right away."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        session_id = await _make_anonymous_session(conn)
    cleanup["users"].append(user_id)
    cleanup["sessions"].append(session_id)

    result = await trips.save_draft(
        session_id=session_id,
        trip_project_id=None,
        title="Logged-in-from-the-start trip",
        origin_name="Denver",
        destination_name="Durango",
        origin=(39.7392, -104.9903),
        destination=(37.2753, -107.8801),
        quiz_answers=None,
        draft_state=None,
        owner_user_id=user_id,
    )
    cleanup["trip_projects"].append(result["id"])

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT owner_user_id FROM app.trip_projects WHERE id = $1", result["id"]
        )
    assert row["owner_user_id"] == user_id


async def test_save_draft_leaves_owner_user_id_null_for_anonymous_session(cleanup):
    """Regression guard for the anonymous path: omitting owner_user_id (the
    default) must still behave exactly as before this fix — ownerless until
    claim_session_for_google_user backfills it at login."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        session_id = await _make_anonymous_session(conn)
    cleanup["sessions"].append(session_id)

    result = await trips.save_draft(
        session_id=session_id,
        trip_project_id=None,
        title="Anonymous trip",
        origin_name=None,
        destination_name=None,
        origin=None,
        destination=None,
        quiz_answers=None,
        draft_state=None,
    )
    cleanup["trip_projects"].append(result["id"])

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT owner_user_id FROM app.trip_projects WHERE id = $1", result["id"]
        )
    assert row["owner_user_id"] is None


async def test_start_finalization_succeeds_for_project_owned_since_creation(cleanup):
    """End-to-end regression test for the reported bug: a user logged in
    BEFORE creating the trip (save_draft stamps owner_user_id immediately,
    see above) must be able to finalize it — this used to 404 because
    owner_user_id was always NULL and claim never ran for them."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        session_id = await _make_anonymous_session(conn)
    cleanup["users"].append(user_id)
    cleanup["sessions"].append(session_id)

    result = await trips.save_draft(
        session_id=session_id,
        trip_project_id=None,
        title="Logged-in-from-the-start trip",
        origin_name="Denver",
        destination_name="Durango",
        origin=(39.7392, -104.9903),
        destination=(37.2753, -107.8801),
        quiz_answers=None,
        draft_state=None,
        owner_user_id=user_id,
    )
    trip_id = result["id"]
    cleanup["trip_projects"].append(trip_id)

    job = await finalize.start_finalization(user_id, session_id, trip_id, idempotency_key=str(uuid.uuid4()))

    assert job.is_new is True
    assert job.status == "pending"

    pool = await get_pool()
    async with pool.acquire() as conn:
        balance = await conn.fetchval("SELECT balance FROM app.credit_accounts WHERE user_id = $1", user_id)
        assert balance == 0


async def test_start_finalization_backfills_ownership_when_session_matches(cleanup):
    """Safety net: a project with owner_user_id IS NULL but whose
    anonymous_session_id matches THIS request's own session (and the caller
    is logged in) gets its ownership assigned right before the strict check
    — which then finds it legitimately, not via a relaxed predicate."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        session_id = await _make_anonymous_session(conn)
    cleanup["users"].append(user_id)
    cleanup["sessions"].append(session_id)

    # owner_user_id intentionally NOT passed -> stays NULL, simulating a
    # project that was never claimed (e.g. predates this fix).
    result = await trips.save_draft(
        session_id=session_id,
        trip_project_id=None,
        title="Never-claimed trip",
        origin_name=None,
        destination_name=None,
        origin=None,
        destination=None,
        quiz_answers=None,
        draft_state=None,
    )
    trip_id = result["id"]
    cleanup["trip_projects"].append(trip_id)

    pool = await get_pool()
    async with pool.acquire() as conn:
        before = await conn.fetchval("SELECT owner_user_id FROM app.trip_projects WHERE id = $1", trip_id)
    assert before is None  # confirms the row really is in the buggy NULL state first

    job = await finalize.start_finalization(user_id, session_id, trip_id, idempotency_key=str(uuid.uuid4()))

    assert job.is_new is True
    pool = await get_pool()
    async with pool.acquire() as conn:
        after = await conn.fetchval("SELECT owner_user_id FROM app.trip_projects WHERE id = $1", trip_id)
        assert after == user_id  # backfilled

        balance = await conn.fetchval("SELECT balance FROM app.credit_accounts WHERE user_id = $1", user_id)
        assert balance == 0  # charged normally, same as any other successful finalize


async def test_start_finalization_never_reassigns_a_project_owned_by_someone_else(cleanup):
    """Negative/credit-protection case: even if the CURRENT caller's session
    happens to match the project's anonymous_session_id (e.g. a shared
    browser/session reused across accounts), the backfill must never touch a
    row that already belongs to someone else — owner_user_id IS NULL is the
    whole guard. The strict check then correctly 404s, and nothing is
    charged to the wrong account."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        owner_id = await _make_user(conn, balance=1)
        attacker_id = await _make_user(conn, balance=1)
        shared_session_id = await _make_anonymous_session(conn)
    cleanup["users"].append(owner_id)
    cleanup["users"].append(attacker_id)
    cleanup["sessions"].append(shared_session_id)

    result = await trips.save_draft(
        session_id=shared_session_id,
        trip_project_id=None,
        title="Owner's trip",
        origin_name=None,
        destination_name=None,
        origin=None,
        destination=None,
        quiz_answers=None,
        draft_state=None,
        owner_user_id=owner_id,
    )
    trip_id = result["id"]
    cleanup["trip_projects"].append(trip_id)

    with pytest.raises(finalize.TripNotFoundError):
        await finalize.start_finalization(
            attacker_id, shared_session_id, trip_id, idempotency_key=str(uuid.uuid4())
        )

    pool = await get_pool()
    async with pool.acquire() as conn:
        # Ownership untouched -- the backfill never fired (owner_user_id was
        # not NULL), so it's still the real owner's, not silently reassigned.
        owner_after = await conn.fetchval("SELECT owner_user_id FROM app.trip_projects WHERE id = $1", trip_id)
        assert owner_after == owner_id

        # Neither account was charged.
        owner_balance = await conn.fetchval("SELECT balance FROM app.credit_accounts WHERE user_id = $1", owner_id)
        attacker_balance = await conn.fetchval(
            "SELECT balance FROM app.credit_accounts WHERE user_id = $1", attacker_id
        )
        assert owner_balance == 1
        assert attacker_balance == 1

        job_count = await conn.fetchval(
            "SELECT count(*) FROM app.finalization_jobs WHERE trip_project_id = $1", trip_id
        )
        assert job_count == 0


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

    job = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))

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
        # finalize.py's snapshot_days comment). No lodging_options_by_day
        # either -> lodging_options is [] for every day (see
        # _sanitize_lodging_options_by_day's default-empty behavior).
        expected_days = [{**d, "lodging": None, "lodging_options": []} for d in _FAKE_ROUTE_DETAIL["days"]]
        assert snapshot["days"] == expected_days
        # quiz_answers here is days=3/flexible_days=True (see _make_trip_with_draft's
        # default), actual is 1 day (_FAKE_ROUTE_DETAIL) — under, not over, so
        # over_plan is False regardless of flexible.
        assert snapshot["day_plan"] == {"requested": 3, "actual": 1, "flexible": True, "over_plan": False}
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

    job = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))

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

    job = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))

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


# --- Re-lodge preview (already-finalized trip): reuses the snapshot's exact
# day boundaries, never re-runs Valhalla/day_split -----------------------

def _fake_finalized_snapshot(days: list[dict], round_trip: bool = False) -> dict:
    return {
        "origin": {"name": "Denver", "lat": 39.7392, "lon": -104.9903},
        "destination": {"name": "Durango", "lat": 37.2753, "lon": -107.8801},
        "stops": [
            {"id": 1, "name": "Stop 1", "category": "Nature & Parks", "rating": 4.5,
             "review_count": 10, "lat": 39.1, "lon": -105.1, "detour_s": 300,
             "why": "x", "tips": None, "dates_note": None, "leg": None},
            {"id": 2, "name": "Stop 2", "category": "Nature & Parks", "rating": 4.2,
             "review_count": 8, "lat": 38.5, "lon": -106.5, "detour_s": 300,
             "why": "x", "tips": None, "dates_note": None, "leg": None},
        ],
        "route": {"duration_s": 30000, "distance_km": 300.0, "shape": "shape", "legs": []},
        "days": days,
        "day_plan": {"requested": None, "actual": len(days), "flexible": True, "over_plan": False},
        "enrichment": {"overview": "", "warnings": [], "sources": []},
        "trip_dates": None,
        "finalized_at": "2026-01-01T00:00:00+00:00",
        "round_trip": round_trip,
    }


async def test_build_relodge_preview_reuses_snapshot_boundaries_no_valhalla_call():
    """Day boundaries/numbers come straight from the finalized snapshot
    (Google-exact) — build_route_through/day_split must never be called;
    only the lodging-search half runs, at each day's already-known
    end_point."""
    days = [
        {"day": 1, "stop_indices": [0], "drive_s": 5000, "visit_s": 3600, "total_s": 8600, "over_limit": False,
         "lodging": None, "lodging_options": []},
        {"day": 2, "stop_indices": [1], "drive_s": 9000, "visit_s": 3600, "total_s": 12600, "over_limit": False,
         "lodging": None, "lodging_options": []},
    ]
    snapshot = _fake_finalized_snapshot(days)
    high_rated = {"place_id": "p_high", "name": "High Rated Lodge", "lat": 0, "lon": 0,
                  "rating": 4.8, "user_ratings_total": 300, "price_level": 3,
                  "vicinity": "town center", "maps_url": "url_high", "distance_m": 2000}

    with patch("services.stops.build_route_through", new=AsyncMock()) as mock_through, \
         patch("services.stops.build_route_through_round_trip", new=AsyncMock()) as mock_through_rt, \
         patch("day_split.split_into_days") as mock_split, \
         patch("accommodations.find_nearest_lodging", new=AsyncMock(return_value=[high_rated])) as mock_lodging:
        preview = await finalize.build_relodge_preview(snapshot, quiz_answers={"drive": "до 4 ч", "detour": "до 30 мин"})

    mock_through.assert_not_called()
    mock_through_rt.assert_not_called()
    mock_split.assert_not_called()

    assert preview["preliminary"] is True
    assert len(preview["days"]) == 2

    day1 = preview["days"][0]
    # Exact numbers preserved byte-for-byte from the snapshot -- never
    # recomputed.
    assert day1["stop_indices"] == [0]
    assert day1["drive_s"] == 5000
    assert day1["total_s"] == 8600
    assert day1["end_point"] == {"lat": 39.1, "lon": -105.1, "near_stop_name": "Stop 1"}
    assert [o["place_id"] for o in day1["lodging_options"]] == ["p_high"]

    day2 = preview["days"][1]
    assert day2["end_point"] == {"lat": 37.2753, "lon": -107.8801, "near_stop_name": None}
    assert day2["lodging_options"] == []  # last day never searched

    assert preview["has_lodging"] is True
    assert preview["needs_selection"] is True

    # Radius still comes from the quiz answer, same mapping as build_finalize_preview.
    mock_lodging.assert_called_once_with(39.1, -105.1, 30000, limit=20)


async def test_build_relodge_preview_round_trip_last_day_ends_at_origin():
    days = [
        {"day": 1, "stop_indices": [0, 1], "drive_s": 20000, "visit_s": 7200, "total_s": 27200, "over_limit": False,
         "lodging": None, "lodging_options": []},
    ]
    snapshot = _fake_finalized_snapshot(days, round_trip=True)

    with patch("services.stops.build_route_through", new=AsyncMock()) as mock_through, \
         patch("accommodations.find_nearest_lodging", new=AsyncMock(return_value=[])):
        preview = await finalize.build_relodge_preview(snapshot, quiz_answers=None)

    mock_through.assert_not_called()
    # Single day IS the last day -> ends at origin (the loop closes there),
    # never the snapshot's `destination` (that's only the pivot X).
    assert preview["days"][0]["end_point"] == {"lat": 39.7392, "lon": -104.9903, "near_stop_name": None}
    assert preview["days"][0]["lodging_options"] == []
    assert preview["needs_selection"] is False  # single day, no night follows it


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

    job = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))

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
        "rating": 4.6, "vicinity": "123 Alpine Way, Ouray", "custom": False,
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


async def test_process_finalization_carries_full_lodging_options_into_snapshot(cleanup):
    """lodging_options_by_day (forwarded by the frontend from its own
    finalize-preview response, see main.py's FinalizeRequest) must land in
    snapshot.days[].lodging_options with every candidate, `selected` computed
    from selected_lodging (not trusted from the payload itself) — while the
    existing single "lodging" field/waypoint behavior stays byte-identical."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip_with_draft(conn, user_id)
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

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

    async def fake_get_directions(origin, destination, waypoints=None):
        return fake_google_result if waypoints else fake_baseline

    selected_lodging = [{
        "day": 1, "place_id": "lodge123", "lat": 39.15, "lon": -105.15, "name": "Mountain Inn",
        "rating": 4.6, "vicinity": "123 Alpine Way, Ouray",
    }]
    lodging_options_by_day = [
        {
            "day": 1,
            "options": [
                {"place_id": "lodge123", "name": "Mountain Inn", "lat": 39.15, "lon": -105.15,
                 "rating": 4.6, "user_ratings_total": 300, "price_level": 2,
                 "vicinity": "123 Alpine Way, Ouray", "maps_url": "https://maps/lodge123"},
                {"place_id": "lodge999", "name": "Roadside Motel", "lat": 39.2, "lon": -105.2,
                 "rating": 3.1, "user_ratings_total": 12, "price_level": 1,
                 "vicinity": "Highway 50", "maps_url": "https://maps/lodge999"},
                # Malformed entry (missing place_id) -- must be dropped, not crash.
                {"name": "No Id Inn", "lat": 39.3, "lon": -105.3},
            ],
        },
        {"day": 2, "options": []},  # last day never gets a picker, but harmless if sent
    ]

    job = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))

    with patch("services.stops.build_route_through", new=AsyncMock(return_value=fake_through)), \
         patch("directions.get_directions", new=AsyncMock(side_effect=fake_get_directions)), \
         patch("enrichment.enrich_route", new=AsyncMock(return_value=_FAKE_ENRICH_RESULT)):
        await finalize.process_finalization(job.id, selected_lodging, lodging_options_by_day)

    pool = await get_pool()
    async with pool.acquire() as conn:
        job_row = await conn.fetchrow(
            "SELECT trip_version_id FROM app.finalization_jobs WHERE id = $1", job.id
        )
        snapshot = json.loads(await conn.fetchval(
            "SELECT snapshot FROM app.trip_versions WHERE id = $1", job_row["trip_version_id"]
        ))

    day1, day2 = snapshot["days"]

    # Existing single-lodging field/behavior: untouched.
    assert day1["lodging"]["place_id"] == "lodge123"

    # New field: every candidate present, malformed one dropped, selected
    # computed from selected_lodging (not from anything in the payload).
    assert [o["place_id"] for o in day1["lodging_options"]] == ["lodge123", "lodge999"]
    chosen = next(o for o in day1["lodging_options"] if o["place_id"] == "lodge123")
    other = next(o for o in day1["lodging_options"] if o["place_id"] == "lodge999")
    assert chosen["selected"] is True
    assert other["selected"] is False
    assert other["name"] == "Roadside Motel"
    assert other["user_ratings_total"] == 12
    assert other["price_level"] == 1
    assert other["vicinity"] == "Highway 50"
    assert other["maps_url"] == "https://maps/lodge999"

    # Day 2 got an explicit empty options list -> stays empty, no crash.
    assert day2["lodging_options"] == []


async def test_process_finalization_with_custom_lodging_point(cleanup):
    """A custom (non-Places) lodging point — place_id=None, custom=True —
    must route exactly like a Places pick (same waypoint insertion, no
    special-casing in _build_route_detail_with_lodging), land in the
    snapshot with custom=True and a coordinate-based maps_url fallback (no
    place_id to build a Places-style link from), and must NOT cause any
    Places candidate shown for that night to be marked selected."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip_with_draft(conn, user_id)
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

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
        "day": 1, "place_id": None, "lat": 39.17, "lon": -105.17, "name": "Своя точка у озера",
        "rating": None, "vicinity": None, "custom": True,
    }]
    # Places had real candidates for day 1 — none of them was picked.
    lodging_options_by_day = [
        {"day": 1, "options": [
            {"place_id": "lodge123", "name": "Mountain Inn", "lat": 39.15, "lon": -105.15,
             "rating": 4.6, "user_ratings_total": 300, "price_level": 2,
             "vicinity": "123 Alpine Way, Ouray", "maps_url": "https://maps/lodge123"},
        ]},
    ]

    job = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))

    with patch("services.stops.build_route_through", new=AsyncMock(return_value=fake_through)), \
         patch("directions.get_directions", new=AsyncMock(side_effect=fake_get_directions)), \
         patch("enrichment.enrich_route", new=AsyncMock(return_value=_FAKE_ENRICH_RESULT)):
        await finalize.process_finalization(job.id, selected_lodging, lodging_options_by_day)

    pool = await get_pool()
    async with pool.acquire() as conn:
        job_row = await conn.fetchrow(
            "SELECT status, trip_version_id FROM app.finalization_jobs WHERE id = $1", job.id
        )
        assert job_row["status"] == "done"
        snapshot = json.loads(await conn.fetchval(
            "SELECT snapshot FROM app.trip_versions WHERE id = $1", job_row["trip_version_id"]
        ))

    # Routed through the custom point's coordinates exactly like a Places pick.
    routed_waypoints = calls[0]
    assert routed_waypoints[1] == (39.17, -105.17)

    day1, day2 = snapshot["days"]
    assert day1["lodging"] == {
        "place_id": None, "name": "Своя точка у озера", "lat": 39.17, "lon": -105.17,
        "maps_url": "https://www.google.com/maps/search/?api=1&query=39.17,-105.17",
        "rating": None, "vicinity": None, "custom": True,
    }
    assert day2["lodging"] is None

    # The Places candidate shown for day 1 must NOT be marked selected —
    # the custom point isn't in this list at all (it wasn't a preview candidate).
    assert [o["place_id"] for o in day1["lodging_options"]] == ["lodge123"]
    assert day1["lodging_options"][0]["selected"] is False


def test_sanitize_lodging_options_by_day_drops_malformed_entries():
    selected = {1: "good-id"}
    raw = [
        {"day": 1, "options": [
            {"place_id": "good-id", "name": "Good Inn", "lat": 1.0, "lon": 2.0},
            {"place_id": "bad-coords", "name": "Bad Inn", "lat": "not-a-number", "lon": 2.0},
            {"name": "No place_id", "lat": 1.0, "lon": 2.0},
            "not-a-dict",
            None,
        ]},
        {"day": "not-an-int", "options": []},  # whole entry dropped
        "not-a-dict-entry",
    ]

    result = finalize._sanitize_lodging_options_by_day(raw, selected)

    assert list(result.keys()) == [1]
    assert [o["place_id"] for o in result[1]] == ["good-id"]
    assert result[1][0]["selected"] is True


def test_sanitize_lodging_options_by_day_fills_missing_optional_fields():
    result = finalize._sanitize_lodging_options_by_day(
        [{"day": 3, "options": [{"place_id": "p1", "name": "Bare Inn", "lat": 1.0, "lon": 2.0}]}],
        {},
    )

    opt = result[3][0]
    assert opt["rating"] is None
    assert opt["user_ratings_total"] is None
    assert opt["price_level"] is None
    assert opt["vicinity"] is None
    assert opt["maps_url"] == "https://www.google.com/maps/place/?q=place_id:p1"
    assert opt["selected"] is False


def test_sanitize_lodging_options_by_day_none_or_wrong_type_returns_empty():
    assert finalize._sanitize_lodging_options_by_day(None, {}) == {}
    assert finalize._sanitize_lodging_options_by_day("not-a-list", {}) == {}
    assert finalize._sanitize_lodging_options_by_day([], {}) == {}


def test_sanitize_lodging_options_by_day_custom_pick_marks_no_places_option_selected():
    """A custom (non-Places) lodging pick has place_id=None in
    selected_place_id_by_day — must never match a candidate via None==None,
    explicit or otherwise (see the `is not None` guard)."""
    result = finalize._sanitize_lodging_options_by_day(
        [{"day": 1, "options": [
            {"place_id": "p1", "name": "Inn One", "lat": 1.0, "lon": 2.0},
            {"place_id": "p2", "name": "Inn Two", "lat": 1.1, "lon": 2.1},
        ]}],
        {1: None},
    )

    assert [o["selected"] for o in result[1]] == [False, False]


def test_selected_lodging_in_accepts_null_place_id():
    """main.SelectedLodgingIn (the finalize endpoint's request model) must
    accept a custom point: place_id omitted/None, custom=True."""
    import main

    parsed = main.SelectedLodgingIn(day=1, lat=39.1, lon=-105.1, name="Своя точка", custom=True)
    assert parsed.place_id is None
    assert parsed.custom is True
    assert parsed.model_dump() == {
        "day": 1, "place_id": None, "lat": 39.1, "lon": -105.1, "name": "Своя точка",
        "rating": None, "vicinity": None, "custom": True,
    }


def _finalized_snapshot_stub(lodging_day1: dict | None) -> dict:
    """Minimal-but-complete FinalizedTripOut-shaped dict — just enough to
    exercise main.FinalizedTripOut's own validation, not a real pipeline run."""
    return {
        "origin": {"name": "Denver", "lat": 39.7, "lon": -104.9},
        "destination": {"name": "Durango", "lat": 37.3, "lon": -107.9},
        "stops": [],
        "route": {"duration_s": 100, "distance_km": 10.0, "shape": "abc", "legs": []},
        "days": [
            {"day": 1, "stop_indices": [], "drive_s": 0, "visit_s": 0, "total_s": 0,
             "over_limit": False, "lodging": lodging_day1, "lodging_options": []},
            {"day": 2, "stop_indices": [], "drive_s": 0, "visit_s": 0, "total_s": 0,
             "over_limit": False, "lodging": None, "lodging_options": []},
        ],
        "day_plan": {"requested": None, "actual": 2, "flexible": True, "over_plan": False},
        "enrichment": {"overview": "", "warnings": [], "sources": []},
        "trip_dates": None,
        "finalized_at": "2026-01-01T00:00:00+00:00",
        "round_trip": False,
    }


def test_finalized_trip_out_accepts_custom_lodging_snapshot():
    """The exact shape finalize.py writes for a custom (non-Places) lodging
    pick — place_id/rating/vicinity all None, custom=True — must parse
    through main.FinalizedTripOut without a validation error (this is what
    GET /trips/{id}/finalized does). Regression: place_id was `str`
    (required), not `str | None`, so this raised a 500 on read even though
    POST /finalize itself had already succeeded."""
    import main

    snapshot = _finalized_snapshot_stub({
        "place_id": None, "name": "Своя точка", "lat": 39.75, "lon": -104.95,
        "maps_url": "https://www.google.com/maps/search/?api=1&query=39.75,-104.95",
        "rating": None, "vicinity": None, "custom": True,
    })

    out = main.FinalizedTripOut(**snapshot, is_first_finalize=False)
    assert out.days[0].lodging.place_id is None
    assert out.days[0].lodging.custom is True


def test_finalized_trip_out_still_accepts_pre_custom_lodging_snapshot():
    """A snapshot finalized before this feature existed never had a `custom`
    key on lodging at all, and place_id was always a real string — must
    still parse, with custom defaulting to False."""
    import main

    snapshot = _finalized_snapshot_stub({
        "place_id": "lodge123", "name": "Mountain Inn", "lat": 39.15, "lon": -105.15,
        "maps_url": "https://www.google.com/maps/place/?q=place_id:lodge123",
        "rating": 4.6, "vicinity": "123 Alpine Way",
        # no "custom" key -- matches a real pre-feature snapshot
    })

    out = main.FinalizedTripOut(**snapshot, is_first_finalize=False)
    assert out.days[0].lodging.place_id == "lodge123"
    assert out.days[0].lodging.custom is False


# --- day_plan: derived from finished snapshot.days, not get_route_detail ---
# fits_plan (see finalize.py's docstring on why it's unused for this) is
# never touched here — quiz_answers["days"]/["flexible_days"] vs
# len(snapshot["days"]) is the only thing exercised.

_TWO_DAY_ROUTE_DETAIL = {
    **_FAKE_ROUTE_DETAIL,
    "days": [
        {"day": 1, "stop_indices": [0], "drive_s": 18000, "visit_s": 3600, "total_s": 21600, "over_limit": False},
        {"day": 2, "stop_indices": [1], "drive_s": 18000, "visit_s": 3600, "total_s": 21600, "over_limit": False},
    ],
}


async def test_day_plan_over_plan_when_actual_exceeds_requested_and_not_flexible(cleanup):
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip_with_draft(conn, user_id, quiz_answers={"drive": "до 4 ч", "days": 1, "flexible_days": False})
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

    job = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))
    with patch("directions.get_route_detail", new=AsyncMock(return_value=_TWO_DAY_ROUTE_DETAIL)), \
         patch("enrichment.enrich_route", new=AsyncMock(return_value=_FAKE_ENRICH_RESULT)):
        await finalize.process_finalization(job.id)

    pool = await get_pool()
    async with pool.acquire() as conn:
        job_row = await conn.fetchrow("SELECT trip_version_id FROM app.finalization_jobs WHERE id = $1", job.id)
        snapshot = json.loads(await conn.fetchval(
            "SELECT snapshot FROM app.trip_versions WHERE id = $1", job_row["trip_version_id"]
        ))

    assert snapshot["day_plan"] == {"requested": 1, "actual": 2, "flexible": False, "over_plan": True}


async def test_day_plan_flexible_suppresses_over_plan(cleanup):
    """Same 1-requested/2-actual mismatch as above, but flexible_days=True —
    the user already said +/-1 day is fine, so over_plan must stay False."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip_with_draft(conn, user_id, quiz_answers={"drive": "до 4 ч", "days": 1, "flexible_days": True})
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

    job = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))
    with patch("directions.get_route_detail", new=AsyncMock(return_value=_TWO_DAY_ROUTE_DETAIL)), \
         patch("enrichment.enrich_route", new=AsyncMock(return_value=_FAKE_ENRICH_RESULT)):
        await finalize.process_finalization(job.id)

    pool = await get_pool()
    async with pool.acquire() as conn:
        job_row = await conn.fetchrow("SELECT trip_version_id FROM app.finalization_jobs WHERE id = $1", job.id)
        snapshot = json.loads(await conn.fetchval(
            "SELECT snapshot FROM app.trip_versions WHERE id = $1", job_row["trip_version_id"]
        ))

    assert snapshot["day_plan"] == {"requested": 1, "actual": 2, "flexible": True, "over_plan": False}


async def test_day_plan_requested_null_when_days_not_answered(cleanup):
    """No "days" key in quiz_answers at all (user never reached/answered that
    quiz step) -> requested=None, over_plan always False regardless of actual."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        user_id = await _make_user(conn, balance=1)
        trip_id = await _make_trip_with_draft(conn, user_id, quiz_answers={"drive": "до 4 ч"})
    cleanup["users"].append(user_id)
    cleanup["trip_projects"].append(trip_id)

    job = await finalize.start_finalization(user_id, uuid.uuid4(), trip_id, idempotency_key=str(uuid.uuid4()))
    with patch("directions.get_route_detail", new=AsyncMock(return_value=_TWO_DAY_ROUTE_DETAIL)), \
         patch("enrichment.enrich_route", new=AsyncMock(return_value=_FAKE_ENRICH_RESULT)):
        await finalize.process_finalization(job.id)

    pool = await get_pool()
    async with pool.acquire() as conn:
        job_row = await conn.fetchrow("SELECT trip_version_id FROM app.finalization_jobs WHERE id = $1", job.id)
        snapshot = json.loads(await conn.fetchval(
            "SELECT snapshot FROM app.trip_versions WHERE id = $1", job_row["trip_version_id"]
        ))

    assert snapshot["day_plan"] == {"requested": None, "actual": 2, "flexible": False, "over_plan": False}
