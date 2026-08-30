# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

For a fuller feature-level walkthrough see `docs/current_functionality.md`; for the
product-level description see `docs/road_trip_planner_mvp.docx`.

## What this is

**Road Trip Planner** — an automated road-trip planner for **Colorado, USA** (UI
entirely in Russian). The user answers a short quiz; the app builds route
alternatives through a corridor, auto-selects worthwhile stops and prices each
one's detour, lets the user edit the stop list for free, then charges one credit
to "finalize" the draft into a precise day-by-day itinerary with an AI guide.

Design principle — **verified geography**: every route number (drive time, detour,
distance) comes from a real routing engine. The LLM (Gemini) only writes
descriptive prose and is never allowed to emit route numbers.

## Repository layout

`roadtrip/` is a **single git repository** containing:

- **`frontend-studio/`** — the React app (React 19 + Vite + TypeScript, Tailwind
  v4). Originally scaffolded in Google AI Studio (`metadata.json`,
  `assets/.aistudio/`, the generic `README.md`). Almost all logic is in
  `src/App.tsx` (~2,600 lines).
- **`backend/`** — FastAPI (Python 3.13) + asyncpg → PostgreSQL/PostGIS. No ORM.
  An orchestration layer over Valhalla, Google Maps, and Gemini. Dependencies are
  in `backend/requirements.txt`; the checked-in `backend/venv/` is already
  populated.
- **`docs/`** — product/functionality write-ups.

`backend/schema.sql` is a **hand-maintained** dump of the `app.*` schema — it is
not applied by any migration tool. `public.attractions` (the POI table, TripAdvisor
data) is a separate concern and not owned by this app.

## Commands

### Frontend (run from `frontend-studio/`)

- `npm install`
- `npm run dev` — Vite dev server on **port 5173** (`vite --port=5173`)
- `npm run build` — `vite build`
- `npm run preview`
- `npm run lint` — type-check only (`tsc --noEmit`); no eslint/prettier configured
- `npm run test:google-maps-export` — runs `src/googleMapsExport.test.ts` via `tsx`

There is no test *runner* configured. Three `*.test.ts` files exist
(`googleMapsExport`, `routeSegments`, `dayAttribution`); only the first has an npm
script. The others are plain `tsx src/<name>.test.ts`.

### Backend (run from `backend/`)

- `venv\Scripts\python -m uvicorn main:app --reload --port 8000` (Windows; venv
  already populated, no install step)
- `venv\Scripts\python -m pytest` — ~85 tests. External APIs are mocked;
  DB-touching tests need a real Postgres reachable at `DATABASE_URL`. `conftest.py`
  sets the anyio backend to asyncio.

### Environment

- Frontend `.env.local` (gitignored): `VITE_GOOGLE_MAPS_KEY` (map won't render
  without it — `TripMap` shows "Карта не загружена"), `VITE_GOOGLE_CLIENT_ID`
  (must equal the backend's `GOOGLE_CLIENT_ID` or every sign-in 401s).
- Backend `.env` (gitignored): `DATABASE_URL` (PostGIS; `.env.example` uses port
  5433), `SESSION_SECRET` (HMAC key for the `rtp_session` cookie),
  `COOKIE_SECURE` (`false` for local http), `GOOGLE_CLIENT_ID`,
  `GOOGLE_GEOCODING_KEY`, `GOOGLE_DIRECTIONS_KEY`, `GEMINI_API_KEY`. The three
  Google keys are deliberately distinct — the Geocoding key is confirmed *not*
  authorized for Directions and vice-versa; Places search reuses the Directions
  key (Places must be separately enabled on it).

## Running services

Valhalla (Docker, :8002), the backend (:8000), and Vite (:5173) are long-running
processes started manually in separate terminals. **Do not start them** — assume
they are already running, or ask. Valhalla is not part of this repo.

Vite proxies `/api/*` → `http://localhost:8000` and strips the `/api` prefix
(`vite.config.ts`), so the browser sees frontend and backend as same-origin (the
`SameSite=Lax` session cookie does not reliably survive a cross-origin
`:5173`→`:8000` fetch). Backend CORS is separately locked to
`http://localhost:5173` (`backend/main.py`). The client base URL is `/api`
(`src/api.ts`); backend routes are declared without the prefix.

## Architecture

### Frontend phase machine (`src/App.tsx`)

```
quiz → refine → generating → plan → finalizing → finalized
```

- **quiz** — 8-step questionnaire (`QUIZ` in `src/data.ts`; mapped to API params by
  `src/quizMapping.ts`). Origin/destination are real-geocoded (`/geocode`), can be
  set by map click / marker drag (reverse-geocoded), and the `trip` answer
  ("Туда и обратно") turns `dest` into a round-trip pivot. Quiz progress + draft
  autosave to the server against an anonymous session.
- **refine** — chat thread pre-seeded with a NL summary of the quiz, plus a
  "Построить маршрут" button. **The chat input is disabled** ("Скоро: правки
  маршрута текстом"); `respondToChat` (canned keyword strings) is unreachable dead
  code. `@google/genai` is a frontend dependency but unused — all AI is
  server-side.
- **generating** — a real `POST /compare-routes` (Valhalla) behind a fixed
  ~3.6 s stepped animation; whichever finishes second transitions to `plan`.
- **plan** — the free draft editor. `MapComponent` on top, then `VariantTabs`
  (up to 3 route alternatives, each with its **own** included-stop set) →
  `DayRibbon` (draft day split, `POST /day-split` — pure arithmetic, no credit) →
  `DayPanel` + `CandidatesPanel` → footer with "Финализировать · 1 кредит".
  Toggling a stop checkbox fires `POST /route-through` (real Valhalla route/detour
  through the included stops) which chains a `/day-split` recompute. Per-variant
  state (`includedByOption`, `routeThroughByOption`, `dayRibbonByOption`, …) is
  fully isolated by option index. Times here are estimates — Valhalla
  over-estimates ~30%.
- **finalizing / finalized** — the paid path. `handleFinalizeClick` → Google
  sign-in if anonymous → free `/finalize-preview` (day split + lodging options) →
  `LodgingSelectionModal` if multi-day → `FinalizeGateModal` (credit check /
  paywall) → `POST /finalize` (charges 1 credit, starts an async job) →
  `FinalizeProgress` polls `/finalize/{job}/status` every 2 s → `FinalizedView`
  renders the immutable snapshot from `/trips/{id}/finalized`.

Shortcuts into the machine: the "Продолжить поездку" banner and "Мои поездки"
drafts call `handleRestoreDraft` → straight to `plan` (byte-for-byte restore, no
re-generation); a finalized "Мои поездки" card → straight to `finalized`;
`FinalizedView` offers "Редактировать черновик" (→ `plan`) and "Добавить/Изменить
ночёвки" (re-lodge → `finalizing` → back to `finalized`).

### Two routing engines — cheap inside, exact on the finalized view

- **Valhalla** (`backend/routing.py`, `http://localhost:8002`, precision-6
  polylines) — everything free: `/compare-routes`, `/route-through`, corridor
  geometry for POI search.
- **Google Directions** (`backend/directions.py`, precision-5 polylines, ≤25
  waypoints, results cached because billed) — only the paid finalize pipeline. It
  reassembles the real shape from every `steps[].polyline` (Google's
  `overview_polyline` is too coarse for mountain switchbacks). Its own no-waypoint
  baseline is also Google, since Valhalla's baseline over-estimates 30–46%.

**Precision must never be crossed.** `src/api.ts` exports `decodeShape` (p6,
Valhalla) and `decodeGoogleShape` (p5, Google); decoding one engine's polyline
with the other silently corrupts every coordinate.

### Day split (`backend/day_split.py`)

`split_into_days(legs, stop_count, daily_limit_s, visit_s=3600, awake_limit_s)` —
greedy, two independent soft ceilings: `daily_limit_s` (driving time alone, from
the quiz's "hours per day") and `awake_limit_s` (driving + all visits, from pace:
relaxed 10h / balanced 12h / packed 14h). A day closes when the next stop would
breach either; a fresh day always accepts its first stop. `visit_s` is a flat
**1 hour for every stop** — real per-place values are a future task. Called from
`/day-split` (draft), `directions.py`, and `finalize.py`.

### Stops / POI (`backend/services/stops.py`, `poi.py`, `detour.py`)

`poi.py` queries `public.attractions` with `ST_DWithin(geom, corridor_linestring,
radius_m)` + category + `review_count >= min`. `detour.py` computes
`detour = max(0, to_poi_s + from_poi_s - baseline_s)` from two Valhalla matrices.
`services/stops.py` orchestrates: thins the corridor to ≤500 points, drops POIs
within ~10% of baseline of either endpoint, marks "suggested" stops spread evenly
along the route by pace interval (highest review count per segment), and builds
the through-route pinning it to the corridor with `via` waypoints. Round-trip:
both legs searched independently, shared POIs deduped onto the smaller-detour leg,
every stop tagged `leg: 0|1`, leg-2 `to_poi_s` offset so the whole app sees one
global ordering; the return leg is chosen to be road-*dissimilar* from the
outbound (OSM `way_id` overlap ≤ 0.70).

### Enrichment (`backend/enrichment.py`)

Gemini `gemini-3.5-flash` via `google-genai`, **two calls** (grounding + strict
structured output can't be combined reliably): call 1 is grounded Google-search
free text (why a place is interesting, practical notes, events on the trip dates);
call 2 reformats that prose + the exact route numbers into strict JSON. Hard rule
in the prompt and the module: the model never computes geography — numbers are
passed in verbatim. Sources come from call 1's `url_citation` annotations.

### Accommodations (`backend/accommodations.py`)

Google Places Nearby (`type=lodging`), re-ranked by a Bayesian score
(`rating * ln(reviews + 1)`), with a "reliable" filter (rating + ≥10 reviews) that
lifts entirely in remote corridors rather than return nothing. The finalize
preview sets `needs_selection = (days > 1) and has_lodging`.

### Finalize (`backend/finalize.py`)

- **Preview** (`build_finalize_preview`) is free: Valhalla through-route +
  `day_split` + one Places lookup per night. **Relodge preview** reuses the
  finalized snapshot's exact Google day boundaries (no re-split).
- **`start_finalization`** is one DB transaction: backfill `owner_user_id` (only
  if this session proves ownership), `SELECT … FOR UPDATE` the project (serializes
  concurrent attempts), idempotency replay by `(trip_project_id,
  idempotency_key)`, in-flight-job dedupe, `SELECT balance … FOR UPDATE`, charge
  −1, insert ledger + `finalization_jobs` row. Cost is **exactly 1 Trip Credit**.
- **`process_finalization`** runs as a background task (Google + Gemini outside any
  transaction), writes a self-contained `trip_versions` snapshot, and on **any**
  exception refunds the credit and returns the project to `draft`.
- Round-trip is detected from `quiz_answers["trip"] == "Туда и обратно"`; the
  "destination" everywhere then means the loop pivot, and the trip ends back at
  origin.

### Persistence (`backend/trips.py`, `src/api.ts`)

No `localStorage`. Draft autosave is `POST /trips` (debounced 1.5 s in `plan`,
plus explicit saves before finalize-preview and finalize). `draft_state` is the
**frontend's own opaque JSON** — the free-tier snapshot only (options, active
index, per-option included sets + route-through, origin/dest). Google detail and
Gemini enrichment are deliberately never in it. `trip_versions.snapshot` is the
immutable finalized result, read by `/trips/{id}/finalized`.

### Auth / sessions (`backend/sessions.py`, `auth.py`)

Anonymous `rtp_session` cookie (`{uuid}.{hmac}`, 90 days, established by
`/session/whoami` on mount). Google ID-token sign-in only (`/auth/google`,
verified against Google's keys; `aud == GOOGLE_CLIENT_ID`, `email_verified`).
Login claims the session's ownerless `trip_projects` into the user in one
transaction (never steals a project already owned). A new user gets a `welcome_gift`
credit (balance 1), granted once. Requesting another user's trip returns 404, not
403 (existence not revealed).

### Data model (`backend/schema.sql`, `app.*` schema)

`anonymous_sessions`, `users` (unique `(auth_provider, provider_sub)`),
`credit_accounts` (`balance`), `credit_ledger` (signed `amount`, `reason` ∈
`welcome_gift` / `finalize:{id}` / `refund:{id}`), `trip_projects`
(`owner_user_id` xor/or `anonymous_session_id`, `status` ∈
`draft`/`finalizing`/`finalized`, `quiz_answers` + `draft_state` jsonb,
`finalized_version_id`), `trip_versions` (`snapshot` jsonb, `ON DELETE CASCADE`),
`finalization_jobs` (`status` ∈ `pending`/`processing`/`done`/`failed`, unique
`(trip_project_id, idempotency_key)`).

### HTTP endpoints (`backend/main.py`)

`GET /` `GET /health` · `GET /session/whoami` `POST /auth/google` `GET /auth/me`
`POST /auth/logout` · `GET /route` `GET /geocode` `GET /reverse-geocode` ·
`POST /trips` `GET /trips/current` `GET /trips` `GET /trips/{id}`
`DELETE /trips/{id}` · `POST /trips/{id}/finalize-preview`
`POST /trips/{id}/relodge-preview` `POST /trips/{id}/finalize`
`GET /finalize/{job_id}/status` `GET /credits` `GET /trips/{id}/finalized` ·
`POST /stops` `POST /route-through` `POST /detail-route` `POST /day-split`
`POST /enrich-route` `POST /compare-routes`.

`/stops`, `/route-through`, `/day-split`, `/compare-routes` have no ownership check
(pure computation). `/detail-route` and `/enrich-route` are paid Finalize steps
left publicly reachable for now and no longer called from the frontend.

### Styling

Tailwind v4 (via `@tailwindcss/vite`, no `tailwind.config`). `src/App.tsx` leans
heavily on custom classes in `src/index.css` (`.app`, `.panel`, `.quiz`, `.opt`,
`.msg`, `.modal`, `.gen-step`, `.editor-content`, `.app--stacked`, …) — check
there before assuming a class is Tailwind. Day colours come from
`src/dayColors.ts` (single source of truth for map segments, badges, legend,
ribbon). Both `tsconfig.json` and `vite.config.ts` alias `@/*` to the
`frontend-studio/` root, not `./src/*`.

## Gotchas

- Polyline precision 6 (Valhalla) vs 5 (Google) — use the matching decoder, never
  mix (see `decodeShape` / `decodeGoogleShape`).
- Colorado only: Valhalla tiles and POI data cover one state. Geocoding is
  US-wide, so a name outside Colorado resolves but then fails at routing time
  (surfaced as 502/503). Fallback coords are Denver → Durango.
- The refine/plan chat compose box is disabled; conversational route-editing is
  not implemented. `respondToChat`, `handleDetailize`, `handleConfirmEnrich`,
  `DateModal`, and `api.ts` `fetchRoute` / `getStops` are present but unreachable
  from the current UI.
- A "simulate the AI" or "make the chat smarter" request means building that
  integration, not tweaking existing logic.
- `backend/schema.sql` is not a migration — schema changes must be applied to the
  DB by hand and mirrored here.
- Concurrency-sensitive spots are already handled and tested: credit charge
  (account row lock), finalize idempotency key, out-of-order geocode/route-through
  responses (sequence counters / `AbortController`). Preserve these.

## Known limitations (temporary)

- Visit time is a flat 1 hour per stop.
- No snap-to-road — a stop with no road access can fail finalize (credit is
  auto-refunded, draft preserved).
- POI data has some coordinate errors (a few fixed by hand; bulk cleanup
  deferred).
- Stripe credit purchase is not built — zero-balance users see "Покупка скоро";
  credits are granted manually. Grant / charge / refund all work.
- `trip_dates` for date-aware enrichment is collected by an (unreachable) modal
  and never written to `quiz_answers` — that search path is dormant.
