import json
import uuid
from datetime import datetime

from db import get_pool


class TripAccessError(Exception):
    """trip_project_id was given but doesn't belong to the current session —
    either it doesn't exist at all, or it's someone else's. Callers decide
    the HTTP status (403 for an update attempt, 404 for a read) themselves;
    this module never assumes which."""


def _dump_json(value: dict | None) -> str | None:
    return json.dumps(value) if value is not None else None


def _row_to_project(row) -> dict:
    d = dict(row)
    d["quiz_answers"] = json.loads(d["quiz_answers"]) if d["quiz_answers"] else None
    d["draft_state"] = json.loads(d["draft_state"]) if d["draft_state"] else None
    return d


_SELECT_FIELDS = """
    id, title, origin_name, destination_name,
    origin_lat, origin_lon, destination_lat, destination_lon,
    status, quiz_answers, draft_state, created_at, updated_at
"""


async def save_draft(
    session_id: uuid.UUID,
    trip_project_id: uuid.UUID | None,
    title: str | None,
    origin_name: str | None,
    destination_name: str | None,
    origin: tuple[float, float] | None,
    destination: tuple[float, float] | None,
    quiz_answers: dict | None,
    draft_state: dict | None,
    owner_user_id: uuid.UUID | None = None,
) -> dict:
    """Creates a new draft (trip_project_id is None) or updates an existing
    one — but an update only ever touches a row this session already owns
    (WHERE ... AND anonymous_session_id = $2). A trip_project_id that doesn't
    resolve under that filter — wrong session, or never existed — raises
    TripAccessError rather than silently creating a new row or updating
    someone else's; the frontend must never be trusted to send back an id
    that's actually its own.

    owner_user_id: the caller's session.user_id at creation time — None for
    an anonymous session (row stays ownerless until claim_session_for_google_user
    backfills it at login, see auth.py), set immediately when the session
    creating the project is ALREADY logged in. Without this, a project
    created by an already-logged-in user would never get an owner at all —
    claim only ever fires on the LOGIN event, which doesn't happen again for
    someone already signed in — and finalize.py's strict owner_user_id check
    would never find it. Only used on CREATE; an update never touches
    ownership, same as before.
    """
    pool = await get_pool()
    origin_lat, origin_lon = origin if origin else (None, None)
    dest_lat, dest_lon = destination if destination else (None, None)

    async with pool.acquire() as conn:
        if trip_project_id is None:
            row = await conn.fetchrow(
                """
                INSERT INTO app.trip_projects
                    (anonymous_session_id, owner_user_id, status, title, origin_name, destination_name,
                     origin_lat, origin_lon, destination_lat, destination_lon,
                     quiz_answers, draft_state)
                VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
                RETURNING id, updated_at
                """,
                session_id, owner_user_id, title, origin_name, destination_name,
                origin_lat, origin_lon, dest_lat, dest_lon,
                _dump_json(quiz_answers), _dump_json(draft_state),
            )
        else:
            row = await conn.fetchrow(
                """
                UPDATE app.trip_projects
                SET title = $3, origin_name = $4, destination_name = $5,
                    origin_lat = $6, origin_lon = $7,
                    destination_lat = $8, destination_lon = $9,
                    quiz_answers = $10::jsonb, draft_state = $11::jsonb
                WHERE id = $1 AND anonymous_session_id = $2
                RETURNING id, updated_at
                """,
                trip_project_id, session_id, title, origin_name, destination_name,
                origin_lat, origin_lon, dest_lat, dest_lon,
                _dump_json(quiz_answers), _dump_json(draft_state),
            )
            if row is None:
                raise TripAccessError(str(trip_project_id))

    return {"id": row["id"], "updated_at": row["updated_at"]}


async def get_current_draft(session_id: uuid.UUID) -> dict | None:
    """The session's most recently updated draft, or None if it has none —
    NOT a list, this phase only ever surfaces one "continue where you left
    off" candidate."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"""
            SELECT {_SELECT_FIELDS}
            FROM app.trip_projects
            WHERE anonymous_session_id = $1 AND status = 'draft'
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            session_id,
        )
    return _row_to_project(row) if row else None


async def get_trip_for_session(session_id: uuid.UUID, user_id: uuid.UUID | None, trip_id: uuid.UUID) -> dict | None:
    """None if the trip doesn't exist OR doesn't belong to the caller —
    deliberately indistinguishable, so the caller can 404 without confirming
    to an attacker that a given id exists but belongs to someone else.

    "Belongs" is either: this exact anonymous session created it
    (anonymous_session_id — still true after a claim, that column never
    changes), or the signed-in user owns it (owner_user_id). Either is
    sufficient; `owner_user_id = $3` is simply never true when user_id is
    NULL (unauthenticated), no separate branch needed for that case.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"""
            SELECT {_SELECT_FIELDS}
            FROM app.trip_projects
            WHERE id = $1 AND (anonymous_session_id = $2 OR owner_user_id = $3)
            """,
            trip_id, session_id, user_id,
        )
    return _row_to_project(row) if row else None


async def get_trip_by_id(trip_id: uuid.UUID) -> dict | None:
    """No ownership check — internal use only (finalize.py's background job,
    which has no session/request context to check against and already
    validated ownership once, at charge time, in start_finalization). Never
    expose this directly through an HTTP endpoint."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT {_SELECT_FIELDS} FROM app.trip_projects WHERE id = $1", trip_id
        )
    return _row_to_project(row) if row else None


async def list_trips_for_user(user_id: uuid.UUID) -> list[dict]:
    """Lightweight rows only, for the "Мои поездки" list — no draft_state/
    quiz_answers, those are only fetched when actually opening one trip
    (get_trip_for_session)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, title, origin_name, destination_name, status, created_at, updated_at
            FROM app.trip_projects
            WHERE owner_user_id = $1
            ORDER BY updated_at DESC
            """,
            user_id,
        )
    return [dict(r) for r in rows]


async def delete_trip(user_id: uuid.UUID, trip_id: uuid.UUID) -> bool:
    """True iff a row was actually deleted. False (not an exception) for
    both "doesn't exist" and "not this user's" — same indistinguishable-404
    reasoning as get_trip_for_session, just for a write instead of a read."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM app.trip_projects WHERE id = $1 AND owner_user_id = $2",
            trip_id, user_id,
        )
    # asyncpg's execute() returns a status string like "DELETE 1" / "DELETE 0".
    return result.rsplit(" ", 1)[-1] != "0"
