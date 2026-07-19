import hashlib
import hmac
import os
import uuid
from dataclasses import dataclass
from datetime import datetime

from dotenv import load_dotenv
from fastapi import Request, Response

from db import get_pool

load_dotenv()

SESSION_SECRET = os.getenv("SESSION_SECRET")
COOKIE_NAME = "rtp_session"
COOKIE_MAX_AGE_S = 60 * 60 * 24 * 90  # 90 days
# false is correct for plain-http localhost dev — a Secure cookie is silently
# dropped by the browser over http, which looks exactly like "sessions don't
# persist" and is easy to misdiagnose as a signing bug instead. Must be true
# in production (https).
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").strip().lower() == "true"


@dataclass
class Session:
    id: uuid.UUID
    is_new: bool
    last_seen_at: datetime
    # None for a plain anonymous session; set once auth.py's /auth/google claim
    # links this session to a real app.users row. Same cookie/session model
    # either way — see start_new_session below for the one thing that changes
    # it (logout).
    user_id: uuid.UUID | None = None


def _sign(session_id: str) -> str:
    if not SESSION_SECRET:
        raise RuntimeError("SESSION_SECRET is not set")
    mac = hmac.new(SESSION_SECRET.encode(), session_id.encode(), hashlib.sha256).hexdigest()
    return f"{session_id}.{mac}"


def _verify(cookie_value: str) -> uuid.UUID | None:
    """Returns the session id iff the cookie's HMAC checks out against
    SESSION_SECRET — never trust session_id from a cookie before this. Without
    it, anyone could hand us an arbitrary UUID and read/extend someone else's
    session just by guessing (or copying) their id."""
    if not SESSION_SECRET or "." not in cookie_value:
        return None

    session_id, _, mac = cookie_value.rpartition(".")
    expected = hmac.new(SESSION_SECRET.encode(), session_id.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, expected):
        return None

    try:
        return uuid.UUID(session_id)
    except ValueError:
        return None


def _set_cookie(response: Response, session_id: uuid.UUID) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=_sign(str(session_id)),
        max_age=COOKIE_MAX_AGE_S,
        path="/",
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
    )


async def start_new_session(response: Response) -> Session:
    """Creates a brand-new anonymous session (no user_id) and points the
    cookie at it. Used both as get_session's fallback (no/invalid/deleted
    cookie) and directly by /auth/logout — logging out doesn't touch the old
    session row (still in the DB, still linked to the user, its trip_projects
    untouched), it just stops using it: the cookie moves to a fresh one."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO app.anonymous_sessions DEFAULT VALUES RETURNING id, last_seen_at, user_id"
        )
    _set_cookie(response, row["id"])
    return Session(id=row["id"], is_new=True, last_seen_at=row["last_seen_at"], user_id=row["user_id"])


async def get_session(request: Request, response: Response) -> Session:
    """FastAPI dependency. Trusts a cookie only after verifying its HMAC; a
    session id that doesn't resolve to a row (signature valid, but the row
    was deleted) is treated the same as no cookie at all — falls through to
    creating a fresh session, never raises for that case."""
    pool = await get_pool()
    cookie_value = request.cookies.get(COOKIE_NAME)
    session_id = _verify(cookie_value) if cookie_value else None

    if session_id is not None:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE app.anonymous_sessions
                SET last_seen_at = now()
                WHERE id = $1
                RETURNING id, last_seen_at, user_id
                """,
                session_id,
            )
        if row is not None:
            return Session(id=row["id"], is_new=False, last_seen_at=row["last_seen_at"], user_id=row["user_id"])

    return await start_new_session(response)
