import os
import uuid
from dataclasses import dataclass

from dotenv import load_dotenv
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from db import get_pool

load_dotenv()

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")

# Both forms appear in the wild depending on token version — Google's own
# tokeninfo docs list both as valid for "iss".
_VALID_ISSUERS = ("accounts.google.com", "https://accounts.google.com")


class TokenVerificationError(Exception):
    """The ID token failed verification — bad signature, expired, wrong
    audience, wrong issuer, or an unverified email. Callers turn this into a
    flat 401; the specific reason is for logs, never surfaced to the client
    (no reason to help an attacker distinguish "expired" from "forged")."""


@dataclass
class GoogleIdentity:
    sub: str
    email: str
    name: str | None


def verify_google_token(credential: str) -> GoogleIdentity:
    """Verifies a Google ID token against Google's own public keys — checks
    signature, expiry, and audience (must equal GOOGLE_CLIENT_ID) via
    google-auth's id_token.verify_oauth2_token. The token's own claims are
    NEVER trusted before this call succeeds; this is the only path into the
    rest of the app that's allowed to read `sub`/`email` off a client-supplied
    token. Issuer and verified-email are checked on top — verify_oauth2_token
    doesn't reject an unverified email itself, only reports the flag.
    """
    if not GOOGLE_CLIENT_ID:
        raise TokenVerificationError("GOOGLE_CLIENT_ID is not set")

    try:
        idinfo = id_token.verify_oauth2_token(credential, google_requests.Request(), GOOGLE_CLIENT_ID)
    except Exception as e:
        raise TokenVerificationError(str(e)) from e

    if idinfo.get("iss") not in _VALID_ISSUERS:
        raise TokenVerificationError(f"unexpected issuer: {idinfo.get('iss')!r}")

    if not idinfo.get("email_verified", False):
        raise TokenVerificationError("email not verified")

    return GoogleIdentity(
        sub=idinfo["sub"],
        email=idinfo["email"],
        name=idinfo.get("name"),
    )


@dataclass
class ClaimResult:
    user_id: uuid.UUID
    email: str
    is_new_user: bool
    claimed_project_ids: list[uuid.UUID]


async def claim_session_for_google_user(session_id: uuid.UUID, identity: GoogleIdentity) -> ClaimResult:
    """Finds-or-creates the app.users row for this Google identity, links the
    current anonymous session to it, and hands over any of that session's
    trip_projects that don't already belong to someone. One transaction: a
    half-completed claim (user created but session not linked, say) would be
    worse than the whole thing failing and the caller retrying.

    Ownership conflicts are handled by construction, not by an explicit check:
    the claim UPDATE only ever touches rows with owner_user_id IS NULL, so a
    project someone else already owns (or this user already owns, from an
    earlier claim) is silently skipped — never overwritten.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            user_row = await conn.fetchrow(
                "SELECT id FROM app.users WHERE auth_provider = 'google' AND provider_sub = $1",
                identity.sub,
            )
            is_new_user = user_row is None

            if user_row is None:
                user_row = await conn.fetchrow(
                    """
                    INSERT INTO app.users (email, auth_provider, provider_sub)
                    VALUES ($1, 'google', $2)
                    RETURNING id
                    """,
                    identity.email, identity.sub,
                )
                new_user_id = user_row["id"]
                # Welcome gift: 1 free Trip Credit on signup — this branch only
                # ever runs for a brand-new user row (is_new_user check above),
                # never on a repeat login, so it can't be granted twice.
                await conn.execute(
                    "INSERT INTO app.credit_accounts (user_id, balance) VALUES ($1, 1)",
                    new_user_id,
                )
                await conn.execute(
                    "INSERT INTO app.credit_ledger (user_id, amount, reason) VALUES ($1, 1, 'welcome_gift')",
                    new_user_id,
                )

            user_id = user_row["id"]

            await conn.execute(
                "UPDATE app.anonymous_sessions SET user_id = $1 WHERE id = $2",
                user_id, session_id,
            )

            claimed_rows = await conn.fetch(
                """
                UPDATE app.trip_projects
                SET owner_user_id = $1
                WHERE anonymous_session_id = $2 AND owner_user_id IS NULL
                RETURNING id
                """,
                user_id, session_id,
            )

    return ClaimResult(
        user_id=user_id,
        email=identity.email,
        is_new_user=is_new_user,
        claimed_project_ids=[r["id"] for r in claimed_rows],
    )


async def get_user(user_id: uuid.UUID) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT id, email FROM app.users WHERE id = $1", user_id)
    return {"id": row["id"], "email": row["email"]} if row else None
