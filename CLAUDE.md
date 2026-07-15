# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

The working directory (`roadtrip/`) is a plain folder, not itself a git repo. It contains two independent projects:

- **`frontend-studio/`** — the actual product: a client-only React app, with its own git repository. Run all frontend commands from here. It was scaffolded/is hosted via Google AI Studio (see `metadata.json`, `assets/.aistudio/`); there's a live deployment at the AI Studio URL referenced in `README.md`.
- **`backend/`** — a small FastAPI proxy in front of a Valhalla routing engine. **Not a git repo**, and has no `requirements.txt`/`pyproject.toml` — dependencies (`fastapi`, `httpx`, `uvicorn`) were installed ad hoc into the checked-in `backend/venv/`. It exists to serve the frontend's not-yet-wired `fetchRoute` stub (see "Unfinished integration point" below); it is not started or referenced by anything in `frontend-studio/`.

## Commands

### Frontend (run from `frontend-studio/`)

- `npm install` — install dependencies
- `npm run dev` — start Vite dev server on port 3000
- `npm run build` — production build (`vite build`)
- `npm run preview` — preview the production build
- `npm run lint` — type-check only (`tsc --noEmit`); there is no separate linter (eslint/prettier) configured
- `npm run clean` — removes `dist` and `server.js`

There is no test runner/framework configured in this project.

### Backend (run from `backend/`)

- `venv\Scripts\python -m uvicorn main:app --reload --port 8000` — start the API (Windows; the venv is already populated, no install step exists)
- Exposes `GET /health` and `GET /route?start_lat=&start_lon=&end_lat=&end_lon=`, which proxies to a Valhalla instance expected at `http://localhost:8002` (`routing.py`). Valhalla itself is **not part of this repo** — it must be running separately for `/route` to work.
- CORS is locked to `http://localhost:5173` in `main.py` (Vite's default port), even though the frontend actually runs on port 3000 — check this if wiring the two together produces CORS errors.

### Environment variables

Frontend: copy `frontend-studio/.env.example` to `.env.local` and fill in:
- `GEMINI_API_KEY` — injected automatically by AI Studio at runtime; not currently referenced anywhere in `src/` (the `@google/genai` dependency is unused so far — chat "AI" replies are canned/keyword-matched, see below)
- `VITE_GOOGLE_MAPS_KEY` — required for the map to render; without it, `TripMap` shows a "Карта не загружена" placeholder instead of throwing

## Architecture

This is a **single-page prototype**, not a fully wired product: most of the "planning" and "AI" behavior is simulated with static demo data and canned logic rather than real backend/LLM calls. Keep this in mind — a request to "make the chat smarter" or "generate a real route" means building that integration, not tweaking existing logic.

### State machine in `src/App.tsx`

Nearly all app state and logic lives in one component, `App.tsx`, which drives a phase machine:

```
quiz → refine → gen → ready
```

- **quiz**: multi-step questionnaire (`QUIZ` in `src/data.ts`) collecting trip preferences into `answers`.
- **refine**: a chat thread pre-seeded with a summary of the quiz answers; user can "adjust" via chat before building the route.
- **gen**: a purely time-based simulation — `setInterval` (550ms) ticks `generationStep` through 6 fixed steps, then transitions to `ready`. No actual route computation happens here.
- **ready**: shows the itinerary (`DAYS` from `src/data.ts`) as expandable day cards with stops, plus a details card for the selected stop and per-day "open in Google/Apple Maps" export buttons.

The progression isn't strictly linear once trip persistence is involved: `handleLoadTrip` restores `phase` from a saved trip's `status`/`plan` — loading a saved **draft** trip drops the user straight into `refine`, skipping `quiz` entirely.

`App.tsx` also owns a large amount of surrounding UI state beyond the phase machine itself: the trip-list/header UI (`showTripsList`, `savedTripsList`, `tripTitle`/`isTitleManuallyEdited`, `saveState`), a fake auth modal gating the `refine → gen` transition (`handleBuildRouteClick`/`handleAuthConfirm` — any of the three "sign in" buttons just proceeds), and an `isInternalUpdate` ref used to distinguish programmatic state changes (e.g. loading a trip) from user-driven ones.

Chat replies in both `refine` and `ready` phases (`respondToChat` in `App.tsx`) are keyword-matched canned strings — not a real LLM call. Refine-phase keywords: `моаб`, `ребён`/`ребен`, `хайк`/`миль`. Ready-phase keywords: `музей`, `плотн`, `крюк`/`45`, `ночёвк`/`ночевк`, `удали`/`убери`. Similarly, the itinerary content (days, stops, coordinates) is a single hardcoded Denver → Las Vegas trip in `src/data.ts` (`DAYS`, `COORDS`, `OVERNIGHTS`, `LINE`); removing/toggling stops manipulates that static data via a `removedIndices` list rather than any recomputation.

### Persistence

`src/storage.ts` wraps `localStorage` (`roadtrip_trips` key) with a simple CRUD API (`listTrips`, `getTrip`, `saveTrip`, `deleteTrip`, `archiveTrip`) over the `SavedTrip` shape (`src/types.ts`). There is no backend/database — everything is per-browser. Saves happen three ways: auto-save every 30s while `hasChanges && phase !== 'quiz'`, explicit snapshots at key transitions (draft after quiz completion in `startRefinement`, ready plan after generation in `startReady`), and a manual save via the header's save button (`handleSave`).

### Map rendering

`src/components/MapComponent.tsx` decides *what* to draw (`drawPath`/`drawStops`/`drawOvernights` booleans) based on `phase`/`generationStep`, and delegates actual rendering to `src/components/TripMap.tsx`, which wraps `@vis.gl/react-google-maps` (raw `google.maps.Polyline` for the route, `AdvancedMarker` for stops/overnights). Markers are keyed by index into the static `COORDS` array — `Stop.i` in `data.ts` must stay aligned with `COORDS` array positions.

There is a **third, independent** hardcoded coordinate set: `src/export.ts` has its own `routePoints` map keyed by day number (1–6) with its own lat/lngs, used only for building Google/Apple Maps export URLs. It duplicates values that already exist in `data.ts`'s `OVERNIGHTS`/`LINE` with no shared source of truth — if the route ever changes, all three places (`COORDS`/`Stop.i`, `OVERNIGHTS`/`LINE`, and `export.ts`'s `routePoints`) need to be updated in sync.

### Unfinished integration point

`src/api.ts` defines `fetchRoute`/`decodeShape` for the real routing backend described above (`backend/`, a FastAPI wrapper around Valhalla, expected at `http://localhost:8000/route`, decoding polylines at precision 6 via `@mapbox/polyline`). The backend now actually exists and matches this stub's expected shape, but `fetchRoute`/`decodeShape` are still **not called from anywhere** in `src/` — the `gen` phase remains a pure `setInterval` simulation. Wiring real route computation into the `gen` phase means calling `fetchRoute` (and having a Valhalla instance running) rather than replacing the simulation's visuals.

### Styling

Tailwind v4 (via `@tailwindcss/vite`, not a `tailwind.config`) is used for most components, but `App.tsx`'s markup relies heavily on custom class names (`.quiz`, `.msg`, `.day`, `.stop`, `.gen-step`, `.card`, `.hints`, `.compose`, `.modal`, etc.) defined in `src/index.css` — check there before assuming a class is Tailwind-generated. Both `tsconfig.json` and `vite.config.ts` define a `@/*` path alias pointing at the **repo root** (`frontend-studio/`), not `./src/*`.

## Running services

Backend (:8000), Vite (:5173) and Valhalla (Docker, :8002) are long-running
processes started manually in separate terminals. Do not start them —
assume they are already running, or ask.

## Known limitations (temporary)

- Valhalla tiles cover Colorado only. Routes outside the state return 400.
  Origin/destination hardcoded to Denver → Durango for this reason.
  Southwest US tiles (CO/UT/NV/AZ) needed before real trips work.
- Demo data (DAYS, COORDS, OVERNIGHTS, export.ts) still describes the
  Denver → Las Vegas trip — markers don't match the drawn line. Known, temporary.
- No geocoding yet: quiz origin/destination text is collected but unused.