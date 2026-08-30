# Road Trip Planner — current functionality

*Snapshot of the codebase as of commit `66cbec5` plus the uncommitted working-tree
changes described at the end. Companion to `road_trip_planner_mvp.docx` (which is
the product-level description); this file is the engineering-level "what the code
actually does today".*

## What it is

An automated road-trip planner for **Colorado, USA** (UI entirely in Russian). It
solves a gap ordinary routing apps leave: they draw A→B but don't tell you *what's
worth stopping for along the way and what each stop costs you in time*. You answer
a short quiz, the app proposes routes through a corridor with automatically
selected stops — each priced honestly ("заехать сюда — +26 мин") — you edit the
stop list for free, then pay one credit to "finalize" a draft into a precise,
day-by-day itinerary with an AI travel guide.

Core principle — **"проверенная география" (verified geography)**: every number
(drive time, detour, distance) comes from real routing engines; the LLM is used
only for descriptive text and is architecturally forbidden from emitting route
numbers. Computed facts and AI-found information are visually separated in the UI.

## Technical shape

| Layer | Stack |
|---|---|
| Frontend | React 19 + Vite + TypeScript, Tailwind v4, `@vis.gl/react-google-maps`. One ~2,600-line `App.tsx` phase machine. Dev server on :5173, all calls proxied to the backend under `/api`. |
| Backend | FastAPI (Python 3.13) + asyncpg → PostgreSQL/PostGIS, no ORM. An orchestration layer over three engines. |
| Routing (free) | Self-hosted **Valhalla** at :8002 — corridor geometry + all free-tier routing. Colorado tiles only. Polyline precision 6. |
| Routing (paid) | **Google Directions** — exact times for finalized trips. Precision 5. Max 25 waypoints, results cached (billed). |
| Places | **Google Places Nearby** (`type=lodging`) for overnight options; **Google Geocoding** (US-wide) for address↔coords. |
| AI | **Google Gemini** (`gemini-3.5-flash`) — per-stop descriptions + grounded web search for events/closures. |
| POI data | `public.attractions` table (TripAdvisor-derived, ~19 categories, Colorado), queried by PostGIS `ST_DWithin` along the route corridor. |
| App data | `app.*` schema: `anonymous_sessions`, `users`, `credit_accounts`, `credit_ledger`, `trip_projects`, `trip_versions`, `finalization_jobs`. Hand-created (not migration-managed). |

## The user journey

Phase machine: **`quiz → refine → generating → plan → finalizing → finalized`**,
with shortcuts back in from "Мои поездки".

### 1. Quiz (free, anonymous)

8 steps (`frontend-studio/src/data.ts`): origin, trip type (one-way / **round-trip**
"Туда и обратно"), destination, days (stepper 1–14 + "±1 день гибкости"), daily
drive limit (до 3/4/6 ч / не важно), acceptable detour (до 15/30/45 мин / до
часа), interests (multi-select: каньоны, горячие источники, маленькие городки,
национальные парки, смотровые, необычные ландшафты, история, еда), pace
(спокойный / сбалансированный / насыщенный).

- Origin/destination are geocoded on blur/next; can also be dropped or clicked on
  the map ("Указать на карте") and reverse-geocoded. Fallback coords: Denver →
  Durango (inside Valhalla's tiles).
- Answers map to API params (`quizMapping.ts`): detour → `max_detour_s`; drive →
  `daily_limit_s`; pace → `relaxed/balanced/packed`; interests → attraction
  categories (deliberately lossy — e.g. "маленькие городки" maps to nothing).
- Progress and the whole draft **autosave server-side** against an anonymous
  cookie session — reload doesn't lose work. A "Продолжить поездку" banner offers
  the most recent draft (never auto-restored — user must click).

### 2. Refine

A chat thread pre-seeded with a natural-language summary of the quiz, then one
button: **"Построить маршрут"**. The chat input itself is **disabled** ("Скоро:
правки маршрута текстом") — conversational route-editing is reserved but not
built. Behind the disabled input, the reply logic is canned keyword matching
(`моаб`, `ребён`, `хайк`), not an LLM.

### 3. Generating

Fires a real `POST /compare-routes` (Valhalla) while a fixed ~3.6 s stepped
progress animation plays; advances to `plan` when both finish (rendezvous — either
can finish first).

### 4. Plan — the free draft editor (main screen)

Map on top, then a vertical stack:

- **Route variants** (`VariantTabs`): up to **3 alternative routes** through the
  same corridor, shown as tabs. Per variant: estimated time/distance, total
  detour for suggested stops, average stop rating, top places, POI count. Each
  variant is drawn as its own coloured line on the map. Each variant carries its
  **own independent** included-stop set — editing one never touches another.
- **Included stops** (checkboxes): seeded from server "suggested" stops (spread
  evenly along the corridor by pace, highest-review pick per segment; endpoints
  and low-value POIs like shops/gas excluded). Toggling a stop → `POST
  /route-through` recomputes the real route/detour/geometry through the included
  stops in travel order (with abort-on-rapid-toggle protection).
- **Day ribbon** (`DayRibbon`): a draft-phase day split via `POST /day-split` —
  pure arithmetic, no Valhalla/Google, **no credit**. Splits origin→stops→dest
  against two ceilings: driving-time limit (quiz answer) and an "awake" limit
  (driving + 1 h per stop, by pace). Dividers are informational, **not
  draggable**; overnight captions read "ночёвка — при финализации".
- **Day panel** (`DayPanel`): the ribbon-selected day's stops, each with its solo
  detour ("крюк в одиночку: N мин"), rating, and a flat "время на месте" (1 h for
  every place in this version).
- **Candidates panel** (`CandidatesPanel`): nearby POIs *not* yet included,
  attributed to the nearest day (`dayAttribution.ts`), one click to add.
- **Round-trip**: the destination becomes the loop pivot; two legs are planned,
  and the return leg is chosen to be road-*dissimilar* from the outbound (OSM
  way-id overlap ≤ 0.70).
- **Map**: draggable A/B endpoint markers (drag → reverse-geocode → rebuild),
  stop markers with detail popups (include/exclude checkbox, rating, `about`
  excerpt, website), row↔marker selection sync.
- **Footer**: "Поездка займёт N дней — планировали M" (red if over plan and not
  flexible) and **"Финализировать · 1 кредит"**.
- Everything autosaves (1.5 s debounce) to `draft_state` — but only the free
  tier: variants, active index, per-variant included sets and route-through,
  origin/dest. Google detail and Gemini enrichment are deliberately never stored
  in a draft.
- Drive time here is explicitly an **estimate** (Valhalla over-estimates ~30%);
  exact time + day breakdown are the paid deliverable.

### 5. Finalize flow

1. **"Финализировать"** → anonymous users hit the only auth wall in the app:
   **Google sign-in** (ID token verified server-side). Price is never shown before
   this point.
2. **Free lodging preview** (`/finalize-preview`): a Valhalla-estimated day split
   plus **lodging options** at each night's stop (Google Places, re-ranked by a
   Bayesian score with junk filtered out). Never charges a credit.
3. If the trip is multi-day and lodging was found → **`LodgingSelectionModal`**
   ("Выберите ночёвки"): pick a hotel per night, or "Указать своё место" (address
   search / pick on map), or "Пропустить".
4. **Credit gate** (`FinalizeGateModal`): balance ≥ 1 → confirm screen (fresh
   idempotency key); balance 0 → paywall ("Нужен 1 Trip Credit" / "Покупка —
   скоро", since Stripe isn't in the MVP).
5. **Confirm** → `POST /finalize`: one DB transaction backfills project ownership,
   locks the credit account, **charges exactly 1 Trip Credit**, and creates a
   `pending` job. Fully idempotent — the same key returns the same job with no
   second charge; an already-running job is reused. A background task does the
   paid work.
6. **Progress** (`FinalizeProgress`): polls every 2 s; staged labels ("Проверяем
   маршрут → Строим сегменты → Готовим гид → Сохраняем") are cosmetic. ~15–20 s.
   The tab can be closed — the job finishes on the server and shows up in "Мои
   поездки".
7. **Background job**: Google Directions (route through stops + any lodging
   waypoints, plus a Google baseline) → `day_split` → Gemini enrichment (two
   calls — a grounded free-text search pass, then a structured-JSON reformat that
   never lets the model compute geography). Writes an **immutable `trip_versions`
   snapshot**. **Any failure → automatic full refund** of the credit; the draft
   is untouched.

### 6. Finalized trip (`FinalizedView`)

The paid result:

- **Exact** Google drive time and distance (no "оценка" tag).
- **Day-by-day breakdown** honouring the drive limit and visit time; days
  colour-coded on the map; collapsible day cards; a per-day "focus" toggle that
  isolates one day on the map; hovering a day thickens its map segments; clicking
  a map segment expands that day's card.
- Per stop: AI guide — why it's interesting, practical tips (access/season/
  parking), and events/closures on your travel dates (if dates were given), all
  marked "по данным поиска".
- Route warnings (switchbacks, vehicle requirements) and a sources list (citation
  links).
- Per-day **"Открыть день в Google Maps"** deep link (start → that day's stops →
  that day's lodging).
- **"Добавить / Изменить ночёвки"** (re-lodge): re-runs the lodging search against
  the snapshot's exact day boundaries (no re-split), through the same paid
  pipeline, producing a new snapshot version.
- **"Редактировать черновик"**: reopens the same trip's editable draft
  (independent of the finalized snapshot).
- **`WelcomeModal`** — shown once, right after the user's first successful
  finalize ("Эта финализация — наш подарок"): the first finalize is free (the
  signup credit), and the price is disclosed only *after* value is delivered.

### 7. Accounts

- **Anonymous session** (HMAC-signed `rtp_session` cookie, 90 days) established on
  load; all free planning works without an account.
- **Google sign-in only.** Login claims the anonymous session's ownerless drafts
  into the account in one transaction; a draft already owned by someone else is
  never stolen (enforced in the DB).
- New account = **1 free Trip Credit** (`welcome_gift`, granted once).
- **"Мои поездки"** (account-only): "Черновики" open in the editor,
  "Финализированные" open read-only. Trips are per-user isolated — requesting
  someone else's returns 404 (existence not revealed).
- Credit spend is **atomic under a row lock** (proven by a real concurrent test);
  double-click or two tabs can't spend twice.

## Monetization (MVP)

All planning is free; one finalize = one Trip Credit. **Stripe purchase is not
built** — zero-balance users see "Покупка — скоро"; credits are granted manually.
Grant / charge / refund all work end-to-end.

## What's not done / limits

- **Region: Colorado only** (Valhalla tiles + POI data). Anything outside surfaces
  as an error.
- **Conversational route-editing** ("убери музеи", "больше природы") — UI
  reserved, not functional; refine-phase chat is canned keywords.
- **Visit time is a flat 1 hour** for every stop (real per-place values planned
  later).
- **No snap-to-road** — a stop with no road access can fail finalize (→ refund).
- **POI coordinates have known errors** (a few fixed by hand; bulk cleanup
  deferred).
- **Travel dates** are collected in a modal that is currently unreachable in the
  editor, and nothing writes them into the trip — so Gemini's date-aware search
  path is effectively dormant.
- **Dead / unreachable in the current editor**: `handleDetailize` (`/detail-route`,
  Google) and `handleConfirmEnrich` (`/enrich-route`, Gemini) exist and work but
  are wired to no button — Finalize reuses those code paths after a real credit
  charge. `api.ts` `fetchRoute` (`/route`) and `getStops` (`/stops`) are also
  unused. In `plan`, day colours therefore appear only in the `DayRibbon`, not on
  the map.
- **Tests**: backend has ~85 pytest tests (detour math, day split, lodging
  ranking, auth/claiming, the full finalize/refund/idempotency/round-trip logic);
  frontend has only 3 `.test.ts` files run ad hoc via `tsx`, no test runner
  configured.

## Working-tree state (uncommitted)

As of writing, the plan-editor refactor is a large **uncommitted** change on top
of `66cbec5` (~1,650 insertions / ~610 deletions):

- `PlanPanel.tsx` deleted, replaced by new untracked components `DayRibbon.tsx`,
  `DayPanel.tsx`, `CandidatesPanel.tsx`, `VariantTabs.tsx`, plus
  `dayAttribution.ts` / `dayAttribution.test.ts`.
- Backend: the draft-phase `POST /day-split` and `POST /trips/{id}/relodge-preview`
  endpoints, `finalize.py` / `geocoding.py` / `main.py` changes, and new
  `test_day_split.py` / expanded `test_finalize.py`.
- Two prototype HTML files at the repo root (`roadtrip-editor-prototype.html`,
  `roadtrip-full-prototype.html`).
