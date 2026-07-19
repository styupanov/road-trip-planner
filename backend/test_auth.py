import uuid
from unittest.mock import patch

import pytest

import auth
import db
from db import get_pool

pytestmark = pytest.mark.anyio


# --- verify_google_token: mocked verification (no real network/DB) -----------
# These stand in for a real Google-signed token via a fake `idinfo`, per the
# ask ("подсунь фейковый idinfo") — id_token.verify_oauth2_token itself is
# where the actual signature/exp/aud checks happen (that's Google's library,
# not ours to re-test); what's ours to verify is that we call it and that we
# add the extra issuer/verified-email checks on top.

def _fake_idinfo(**overrides):
    idinfo = {
        "sub": "google-sub-123",
        "email": "person@example.com",
        "email_verified": True,
        "iss": "https://accounts.google.com",
        "name": "Test Person",
    }
    idinfo.update(overrides)
    return idinfo


def test_verify_google_token_extracts_identity():
    with patch("auth.id_token.verify_oauth2_token", return_value=_fake_idinfo()):
        identity = auth.verify_google_token("fake-token")

    assert identity.sub == "google-sub-123"
    assert identity.email == "person@example.com"
    assert identity.name == "Test Person"


def test_verify_google_token_rejects_unverified_email():
    with patch("auth.id_token.verify_oauth2_token", return_value=_fake_idinfo(email_verified=False)):
        with pytest.raises(auth.TokenVerificationError):
            auth.verify_google_token("fake-token")


def test_verify_google_token_rejects_bad_issuer():
    with patch("auth.id_token.verify_oauth2_token", return_value=_fake_idinfo(iss="evil.example.com")):
        with pytest.raises(auth.TokenVerificationError):
            auth.verify_google_token("fake-token")


def test_verify_google_token_rejects_when_google_library_raises():
    # Bad signature, expired, wrong audience — google-auth raises its own
    # exception for all of these; we never inspect which, just refuse.
    with patch("auth.id_token.verify_oauth2_token", side_effect=ValueError("Token expired")):
        with pytest.raises(auth.TokenVerificationError):
            auth.verify_google_token("fake-token")


# --- claim_session_for_google_user: real DB, no mocking ----------------------
# Exercises actual app.users/app.credit_accounts/app.anonymous_sessions/
# app.trip_projects rows against the dev database — the whole point of this
# logic is the SQL or joins done right. Everything created here is torn down
# in `cleanup`/fixtures regardless of pass/fail.

async def _make_anonymous_session(conn) -> uuid.UUID:
    row = await conn.fetchrow("INSERT INTO app.anonymous_sessions DEFAULT VALUES RETURNING id")
    return row["id"]


async def _make_other_user(conn) -> uuid.UUID:
    row = await conn.fetchrow(
        """
        INSERT INTO app.users (email, auth_provider, provider_sub)
        VALUES ('other@example.com', 'google', $1)
        RETURNING id
        """,
        f"other-sub-{uuid.uuid4()}",
    )
    return row["id"]


@pytest.fixture
async def cleanup():
    """Collects ids created during a test and deletes them afterward,
    respecting FK order (trip_projects -> credit_accounts/anonymous_sessions
    -> users).

    Also resets db.py's module-level pool singleton around the test: anyio's
    pytest runner gives each async test its own event loop, but asyncpg pools
    are bound to the loop they were created on — reusing the pool across tests
    (each with a different loop) fails with a low-level asyncpg InterfaceError
    that has nothing to do with the actual test logic. The production app
    never hits this (one process, one loop, one pool for its whole lifetime);
    it's purely a test-runner artifact.
    """
    db._pool = None
    created = {"trip_projects": [], "sessions": [], "users": []}
    try:
        yield created
    finally:
        pool = await get_pool()
        async with pool.acquire() as conn:
            if created["trip_projects"]:
                await conn.execute(
                    "DELETE FROM app.trip_projects WHERE id = ANY($1::uuid[])", created["trip_projects"]
                )
            if created["sessions"]:
                await conn.execute(
                    "DELETE FROM app.anonymous_sessions WHERE id = ANY($1::uuid[])", created["sessions"]
                )
            if created["users"]:
                # credit_ledger has no ON DELETE CASCADE on user_id — the
                # welcome-gift row (Фаза 3) would block deleting the user
                # otherwise.
                await conn.execute(
                    "DELETE FROM app.credit_ledger WHERE user_id = ANY($1::uuid[])", created["users"]
                )
                await conn.execute(
                    "DELETE FROM app.credit_accounts WHERE user_id = ANY($1::uuid[])", created["users"]
                )
                await conn.execute("DELETE FROM app.users WHERE id = ANY($1::uuid[])", created["users"])
        await pool.close()
        db._pool = None


async def test_claim_creates_new_user_with_credit_account_and_claims_null_owned_projects(cleanup):
    pool = await get_pool()
    async with pool.acquire() as conn:
        session_id = await _make_anonymous_session(conn)
        cleanup["sessions"].append(session_id)

        # A draft this anonymous session made before signing in — no owner yet.
        unowned = await conn.fetchrow(
            "INSERT INTO app.trip_projects (anonymous_session_id, status) VALUES ($1, 'draft') RETURNING id",
            session_id,
        )
        cleanup["trip_projects"].append(unowned["id"])

        # Some OTHER project that happens to also carry this session id (edge
        # case: a session that got reused/shared) but is already owned by a
        # different real user — must never be reassigned.
        other_user_id = await _make_other_user(conn)
        cleanup["users"].append(other_user_id)
        foreign = await conn.fetchrow(
            """
            INSERT INTO app.trip_projects (anonymous_session_id, owner_user_id, status)
            VALUES ($1, $2, 'draft') RETURNING id
            """,
            session_id, other_user_id,
        )
        cleanup["trip_projects"].append(foreign["id"])

    identity = auth.GoogleIdentity(sub=f"new-sub-{uuid.uuid4()}", email="new@example.com", name="New Person")
    result = await auth.claim_session_for_google_user(session_id, identity)
    cleanup["users"].append(result.user_id)

    assert result.is_new_user is True
    assert result.email == "new@example.com"
    assert result.claimed_project_ids == [unowned["id"]]  # foreign NOT included

    pool = await get_pool()
    async with pool.acquire() as conn:
        user_row = await conn.fetchrow(
            "SELECT auth_provider, provider_sub FROM app.users WHERE id = $1", result.user_id
        )
        assert user_row["auth_provider"] == "google"
        assert user_row["provider_sub"] == identity.sub

        # Фаза 3: a new user gets a 1-credit welcome gift, not an empty account.
        credit_row = await conn.fetchrow(
            "SELECT balance FROM app.credit_accounts WHERE user_id = $1", result.user_id
        )
        assert credit_row is not None
        assert credit_row["balance"] == 1

        ledger_row = await conn.fetchrow(
            "SELECT amount, reason FROM app.credit_ledger WHERE user_id = $1", result.user_id
        )
        assert ledger_row is not None
        assert ledger_row["amount"] == 1
        assert ledger_row["reason"] == "welcome_gift"

        session_row = await conn.fetchrow(
            "SELECT user_id FROM app.anonymous_sessions WHERE id = $1", session_id
        )
        assert session_row["user_id"] == result.user_id

        unowned_row = await conn.fetchrow(
            "SELECT owner_user_id FROM app.trip_projects WHERE id = $1", unowned["id"]
        )
        assert unowned_row["owner_user_id"] == result.user_id

        # The foreign-owned project must be untouched — still the other user's.
        foreign_row = await conn.fetchrow(
            "SELECT owner_user_id FROM app.trip_projects WHERE id = $1", foreign["id"]
        )
        assert foreign_row["owner_user_id"] == other_user_id


async def test_claim_reuses_existing_user_without_duplicating(cleanup):
    pool = await get_pool()
    async with pool.acquire() as conn:
        session_id = await _make_anonymous_session(conn)
    cleanup["sessions"].append(session_id)

    identity = auth.GoogleIdentity(sub=f"repeat-sub-{uuid.uuid4()}", email="repeat@example.com", name=None)

    first = await auth.claim_session_for_google_user(session_id, identity)
    cleanup["users"].append(first.user_id)
    assert first.is_new_user is True

    # Same identity claiming again (e.g. a second sign-in) must find the same
    # user, not insert a second app.users row (would violate the
    # (auth_provider, provider_sub) unique constraint) or a second
    # credit_accounts row (would violate its user_id PK).
    second = await auth.claim_session_for_google_user(session_id, identity)
    assert second.is_new_user is False
    assert second.user_id == first.user_id

    pool = await get_pool()
    async with pool.acquire() as conn:
        count = await conn.fetchval(
            "SELECT count(*) FROM app.users WHERE auth_provider = 'google' AND provider_sub = $1",
            identity.sub,
        )
        assert count == 1
