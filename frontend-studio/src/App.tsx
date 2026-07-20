import React, { useState, useEffect, useRef } from 'react';
import { ChatMessage, QuizAnswerValue } from './types';
import { QUIZ } from './data';
import { MapComponent } from './components/MapComponent';
import { GenerationProgress } from './components/GenerationProgress';
import { Header } from './components/Header';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { MyTripsModal } from './components/MyTripsModal';
import {
  getCompareRoutes, postRouteThrough, postDetailRoute, postEnrichRoute, getWhoAmI,
  saveTrip, getCurrentTrip, getMyTrips, getTrip, deleteTrip, loginWithGoogle, getMe, logout,
  getCredits, postFinalizePreview, postFinalizeTrip, getFinalizeStatus, getFinalizedTrip,
  decodeShape, decodeGoogleShape, geocode, reverseGeocode,
  ApiStop, RouteOption, DetailRouteResult, EnrichRouteResult, TripProject, TripSummary,
  CreditsResult, FinalizedTripResult, FinalizePreviewResult, SelectedLodging,
} from './api';
import { mapDetourToMaxDetourS, mapDriveToDailyLimitS, mapInterestsToCategories, mapPaceToApiPace } from './quizMapping';
import { dayColor } from './dayColors';
import { splitPathIntoLegs } from './routeSegments';
import { PlanPanel, RouteThroughSummary } from './components/PlanPanel';
import { DateModal } from './components/DateModal';
import { FinalizeGateModal } from './components/FinalizeGateModal';
import { FinalizeProgress } from './components/FinalizeProgress';
import { FinalizedView } from './components/FinalizedView';
import { WelcomeModal } from './components/WelcomeModal';
import { LodgingSelectionModal } from './components/LodgingSelectionModal';

// Default/fallback coordinates, used for route building if geocoding never resolves.
// Must stay within Colorado — Valhalla's tiles only cover this state.
const TRIP_ORIGIN = { lat: 39.7392, lng: -104.9903 }; // Денвер
const TRIP_DEST = { lat: 37.2753, lng: -107.8801 }; // Дуранго

interface FieldGeocodeState {
  text: string;
  status: 'unresolved' | 'loading' | 'resolved' | 'error';
  error: string;
  // Provenance of the current coordinate: forward-geocoded from typed text, or dragged on the map.
  // Explicit rather than inferred from text, since a dragged coordinate is more precise than
  // whatever a forward geocode of its reverse-geocoded label would return.
  source: 'geocode' | 'drag' | null;
}
const EMPTY_GEO_STATE: FieldGeocodeState = { text: '', status: 'unresolved', error: '', source: null };

// JSON-safe shape of TripProject.draft_state (api.ts) — the frontend's own
// contract, opaque to the backend. Map/Set values are serialized as entries
// arrays since JSON has neither. Deliberately excludes detailedByOption/
// enrichedByOption: Google detail-route and Gemini enrichment are billable
// and belong to Finalize (Phase 2), not a free autosaved draft — day_split
// is cheap enough to just recompute client-side from the restored legs
// instead of caching it here (see PlanPanel, which already does this on the
// fly whenever `detail` is present).
interface DraftStateSnapshot {
  version: 1;
  options: RouteOption[];
  activeOptionIndex: number;
  includedByOption: [number, number[]][];
  routeThroughByOption: [number, RouteThroughSummary][];
  routeOrigin: { lat: number; lng: number } | null;
  routeDest: { lat: number; lng: number } | null;
}

export default function App() {
  // Application Phase. 'finalizing'/'finalized' (Фаза 3, подшаг 3) are only
  // ever entered from 'plan' (Finalize confirm -> job -> result) or directly
  // from "Мои поездки" ('finalized' only, opening an already-finalized trip).
  const [phase, setPhase] = useState<'quiz' | 'refine' | 'generating' | 'plan' | 'finalizing' | 'finalized'>('quiz');

  // Quiz State
  const [step, setStep] = useState<number>(0);
  const [answers, setAnswers] = useState<Record<string, QuizAnswerValue>>({});

  // Server-side draft persistence (Фаза 1, шаг 3) — replaces the old
  // localStorage-backed save/trips-list entirely, not alongside it.
  const [tripProjectId, setTripProjectId] = useState<string | null>(null);
  const [tripTitle, setTripTitle] = useState<string>('Новая поездка');
  const [isTitleManuallyEdited, setIsTitleManuallyEdited] = useState<boolean>(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  // The session's most recent draft, fetched once on mount — powers the
  // "Продолжить поездку" banner. Never applied automatically; the user has to
  // click it (see the banner's onClick) so a fresh quiz never gets silently
  // clobbered by an old draft.
  const [resumableTrip, setResumableTrip] = useState<TripProject | null>(null);
  const [resumeBannerDismissed, setResumeBannerDismissed] = useState<boolean>(false);
  const [showConfirmNewTrip, setShowConfirmNewTrip] = useState<boolean>(false);

  // Sequence counters guarding against out-of-order geocode/reverse-geocode responses
  // (e.g. a slow forward-geocode resolving after a later drag already set a better coordinate)
  const originRequestSeq = useRef<number>(0);
  const destRequestSeq = useRef<number>(0);

  // Chat State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState<string>('');

  // Itinerary State
  const [routeLine, setRouteLine] = useState<{ lat: number; lng: number }[]>([]);
  // Route alternatives from /compare-routes, all shown/editable simultaneously in
  // the 'plan' phase — no separate "choose a route" step.
  const [options, setOptions] = useState<RouteOption[]>([]);
  const [activeOptionIndex, setActiveOptionIndex] = useState<number>(0);
  // Per-option checkbox state — editing one option's stops never touches another's.
  const [includedByOption, setIncludedByOption] = useState<Map<number, Set<number>>>(new Map());
  // Per-option through-route result (real total_s/delta_s/through_shape), populated
  // initially from /compare-routes' own suggested-stop computation, then refreshed
  // per-option whenever that option's checkboxes change.
  const [routeThroughByOption, setRouteThroughByOption] = useState<Map<number, RouteThroughSummary>>(new Map());
  // Which option currently has an in-flight /route-through request, or null — used to
  // show a non-blocking "recomputing" indicator only on the tab it actually applies to.
  const [loadingOptionIndex, setLoadingOptionIndex] = useState<number | null>(null);
  const routeThroughAbortRef = useRef<AbortController | null>(null);
  // Debounce timer for the server autosave effect further down.
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-option Google Directions detail — exact numbers, distinct from the Valhalla-
  // estimated routeThroughByOption above. Isolated by option like includedByOption:
  // detailing option 0 never touches option 1's state. An entry is removed the moment
  // that option's checkboxes change (see handleToggleStop) since it's now stale.
  const [detailedByOption, setDetailedByOption] = useState<Map<number, DetailRouteResult>>(new Map());
  // Which option currently has an in-flight /detail-route request, or null.
  const [detailLoadingOptionIndex, setDetailLoadingOptionIndex] = useState<number | null>(null);
  // Per-option Gemini enrichment — same isolation rule as detailedByOption: keyed
  // by option, cleared for that option the moment its checkboxes change.
  const [enrichedByOption, setEnrichedByOption] = useState<Map<number, EnrichRouteResult>>(new Map());
  // Which option currently has an in-flight /enrich-route request, or null.
  const [enrichLoadingOptionIndex, setEnrichLoadingOptionIndex] = useState<number | null>(null);
  const [showDateModal, setShowDateModal] = useState<boolean>(false);
  const [selectedStopId, setSelectedStopId] = useState<number | null>(null);
  // Origin/destination actually used to build the current itinerary — snapshotted at
  // generation time, independent of the draggable A/B markers' live originCoord/destCoord
  const [routeOrigin, setRouteOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [routeDest, setRouteDest] = useState<{ lat: number; lng: number } | null>(null);
  // Read by tryFinishGeneration (see startGeneration) once it's called, to know the
  // fetched options — a ref because the fetch and the fixed-duration animation are
  // two independent async chains and the check needs the latest value without
  // waiting on a re-render.
  const pendingOptionsRef = useRef<RouteOption[] | null>(null);
  // Rendezvous flags for startGeneration's animation-vs-fetch race: the transition to
  // 'plan' only fires once BOTH the fetch has resolved (pendingOptionsRef set) AND the
  // minimum animation duration has elapsed (animationDoneRef set) — whichever finishes
  // second triggers it. generationTransitionedRef guards against firing twice.
  const animationDoneRef = useRef<boolean>(false);
  const generationTransitionedRef = useRef<boolean>(false);
  const [originCoord, setOriginCoord] = useState<{ lat: number; lng: number } | null>(null);
  const [destCoord, setDestCoord] = useState<{ lat: number; lng: number } | null>(null);
  const [originGeo, setOriginGeo] = useState<FieldGeocodeState>(EMPTY_GEO_STATE);
  const [destGeo, setDestGeo] = useState<FieldGeocodeState>(EMPTY_GEO_STATE);
  const [quizNextLoading, setQuizNextLoading] = useState<boolean>(false);
  // Which field a "pick on the map" click will set, or null when not in picking mode
  const [pickingField, setPickingField] = useState<'origin' | 'dest' | null>(null);

  // Generation Timer State
  const [generationStep, setGenerationStep] = useState<number>(0);

  // Summary Modifiers
  const [detourSummary, setDetourSummary] = useState<string>('');

  // Same modal for both "Finalize" (PlanPanel) and the header's "Войти" —
  // Google sign-in either way, see handleGoogleCredential. Closing it never
  // touches the draft; it's a plain overlay over whatever screen was showing.
  const [showFinalizeModal, setShowFinalizeModal] = useState<boolean>(false);
  const [authModalError, setAuthModalError] = useState<string | null>(null);
  // Set right before opening the sign-in modal from Finalize specifically
  // (not from the header's plain "Войти") — handleGoogleCredential checks
  // this after a successful login to resume straight into the balance
  // check/confirm screen, instead of just closing the modal.
  const [pendingAuthAction, setPendingAuthAction] = useState<'finalize' | null>(null);

  // Фаза 3, подшаг 3: Finalize flow state. null/'paywall'/'confirm' drives
  // FinalizeGateModal; the idempotency key is generated once per visit to
  // the confirm screen (openFinalizeGate), never per click/retry — a failed
  // POST can be safely retried with the SAME key (see postFinalizeTrip).
  const [finalizeGateStage, setFinalizeGateStage] = useState<'paywall' | 'confirm' | null>(null);
  const [finalizeIdempotencyKey, setFinalizeIdempotencyKey] = useState<string | null>(null);
  const [finalizeSubmitting, setFinalizeSubmitting] = useState<boolean>(false);
  const [finalizeGateError, setFinalizeGateError] = useState<string | null>(null);
  const [finalizeJobId, setFinalizeJobId] = useState<string | null>(null);
  const finalizePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The immutable result of a completed Finalize — populated either by the
  // just-finished job (loadFinalizedResult) or by opening an already-
  // finalized trip from "Мои поездки" (handleOpenFinalizedFromList).
  const [finalizedTrip, setFinalizedTrip] = useState<FinalizedTripResult | null>(null);
  const [credits, setCredits] = useState<CreditsResult | null>(null);
  const [showWelcomeModal, setShowWelcomeModal] = useState<boolean>(false);

  // Ночёвки: free finalize-preview result, shown between the Finalize click
  // and the paywall/confirm step (never charges a credit) — see
  // startFinalizePreview. The lodging picker only opens when
  // finalizePreview.needs_selection is true; otherwise this flows straight
  // into openFinalizeGate with selectedLodging left null.
  const [finalizePreview, setFinalizePreview] = useState<FinalizePreviewResult | null>(null);
  const [finalizePreviewLoading, setFinalizePreviewLoading] = useState<boolean>(false);
  const [showLodgingModal, setShowLodgingModal] = useState<boolean>(false);
  // The user's choice for THIS finalize attempt — deliberately not part of
  // draft_state/buildDraftPayload: it's spent the moment finalize succeeds
  // or fails, never something to restore into a later session.
  const [selectedLodging, setSelectedLodging] = useState<SelectedLodging[] | null>(null);

  // Auth state (Фаза 2) — who the CURRENT session is linked to, if anyone.
  // Fetched once on mount via getMe(); updated in place by
  // handleGoogleCredential (login) and handleLogoutClick (logout), never
  // touching phase/options/tripProjectId — signing in/out never navigates
  // away from whatever trip is currently open.
  const [authState, setAuthState] = useState<{ authenticated: boolean; email: string | null }>({
    authenticated: false,
    email: null,
  });

  // "Мои поездки" (Фаза 2, шаг 3) — only ever fetched while the modal is
  // open (see the effect below), not kept warm in the background.
  const [showMyTripsModal, setShowMyTripsModal] = useState<boolean>(false);
  const [myTrips, setMyTrips] = useState<TripSummary[]>([]);
  const [isMyTripsLoading, setIsMyTripsLoading] = useState<boolean>(false);

  // Refs for scrolling and auto-scroll chat
  const streamRef = useRef<HTMLDivElement>(null);

  // Auto-scroll stream when messages or stop selection change
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [messages, phase, step]);

  // Fetches the session's most recent draft on mount, purely to offer the
  // "Продолжить поездку" banner — never applied automatically (see
  // resumableTrip's own comment). A failure here just means no banner shows;
  // starting a fresh quiz still works fine either way.
  useEffect(() => {
    getCurrentTrip()
      .then(trip => setResumableTrip(trip))
      .catch(err => console.error('Failed to fetch current draft:', err));
  }, []);

  // Establishes the anonymous session (rtp_session cookie) on first load —
  // nothing reads the result yet (Фаза 1, шаг 2 is just wiring the plumbing
  // through), but the request has to actually fire once for the backend to
  // ever set the cookie in the first place. Failure is non-fatal — the rest
  // of the app works without a session, just without persistence tied to it.
  useEffect(() => {
    getWhoAmI().catch(err => console.error('Failed to establish session:', err));
  }, []);

  // Фаза 2: is the current session linked to a Google account? Drives the
  // header (email + "Выйти" vs "Войти"). A page reload lands here again —
  // this is what makes "reload, still logged in" work, there's no separate
  // client-side token to persist, the rtp_session cookie already carries it.
  useEffect(() => {
    getMe()
      .then(me => setAuthState({ authenticated: me.authenticated, email: me.email }))
      .catch(err => console.error('Failed to fetch auth state:', err));
  }, []);

  // Fetches the list only while "Мои поездки" is actually open — not kept
  // warm in the background, and re-fetched fresh every time it opens (so a
  // trip finalized/deleted elsewhere doesn't show stale).
  useEffect(() => {
    if (!showMyTripsModal) return;
    setIsMyTripsLoading(true);
    getMyTrips()
      .then(list => setMyTrips(list))
      .catch(err => console.error('Failed to fetch my trips:', err))
      .finally(() => setIsMyTripsLoading(false));
  }, [showMyTripsModal]);

  // Map picking mode is quiz-only — never let it linger into another phase
  useEffect(() => {
    if (phase !== 'quiz') setPickingField(null);
  }, [phase]);

  // Esc cancels map picking mode
  useEffect(() => {
    if (!pickingField) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickingField(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pickingField]);

  // Auto-generate title from origin and dest if not manually edited
  useEffect(() => {
    if (!isTitleManuallyEdited) {
      const originVal = answers.origin ? (Array.isArray(answers.origin) ? answers.origin[0] : answers.origin) : '';
      const destVal = answers.dest ? (Array.isArray(answers.dest) ? answers.dest[0] : answers.dest) : '';
      if (originVal || destVal) {
        setTripTitle(`${originVal || '...'} → ${destVal || '...'}`);
      } else {
        setTripTitle('Новая поездка');
      }
    }
  }, [answers.origin, answers.dest, isTitleManuallyEdited]);

  // Quiz Actions
  const currentQuestion = QUIZ[step];
  const currentFieldGeo = currentQuestion.k === 'origin' ? originGeo : currentQuestion.k === 'dest' ? destGeo : null;
  const currentFieldGeoError =
    currentFieldGeo &&
    currentFieldGeo.status === 'error' &&
    currentFieldGeo.text === ((answers[currentQuestion.k] as string) || '').trim()
      ? currentFieldGeo.error
      : null;

  const handleTextAnswerChange = (val: string) => {
    setAnswers(prev => ({ ...prev, [currentQuestion.k]: val }));

    // Address changed since the last geocode attempt — drop the stale coordinate/status
    if (currentQuestion.k === 'origin' && val.trim() !== originGeo.text) {
      setOriginCoord(null);
      setOriginGeo(EMPTY_GEO_STATE);
    } else if (currentQuestion.k === 'dest' && val.trim() !== destGeo.text) {
      setDestCoord(null);
      setDestGeo(EMPTY_GEO_STATE);
    }
  };

  const handleSelectOption = (opt: string) => {
    setAnswers(prev => {
      const current = prev[currentQuestion.k];
      if (currentQuestion.type === 'one') {
        return { ...prev, [currentQuestion.k]: opt };
      } else {
        const currentList = Array.isArray(current) ? current : [];
        const newList = currentList.includes(opt)
          ? currentList.filter(item => item !== opt)
          : [...currentList, opt];
        return { ...prev, [currentQuestion.k]: newList };
      }
    });
  };

  const DAYS_MIN = 1;
  const DAYS_MAX = 14;

  const daysValue = (): number => {
    const val = answers.days;
    if (typeof val === 'number') return val;
    if (typeof currentQuestion.def === 'number') return currentQuestion.def;
    return 4;
  };

  const handleDaysStep = (delta: number) => {
    setAnswers(prev => {
      const current = typeof prev.days === 'number' ? prev.days : daysValue();
      const next = Math.min(DAYS_MAX, Math.max(DAYS_MIN, current + delta));
      return { ...prev, days: next };
    });
  };

  const handleFlexibleDaysToggle = (checked: boolean) => {
    setAnswers(prev => ({ ...prev, flexible_days: checked }));
  };

  const isCurrentStepValid = () => {
    if (currentQuestion.k === 'avoid') return true; // optional
    const val = answers[currentQuestion.k];
    if (currentQuestion.type === 'text') {
      return typeof val === 'string' && val.trim() !== '';
    }
    if (currentQuestion.type === 'one') {
      return !!val;
    }
    if (currentQuestion.type === 'many') {
      return Array.isArray(val) && val.length > 0;
    }
    if (currentQuestion.type === 'days') {
      return true; // stepper always has a value (state or def) — nothing to validate
    }
    return false;
  };

  // Resolves origin/destination text into coordinates, caching by the last-attempted text
  // so unchanged input doesn't re-hit the geocoding API. Updates the shared coord state on success.
  const resolveFieldCoords = async (field: 'origin' | 'dest', text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (trimmed === '') return false;

    const geoState = field === 'origin' ? originGeo : destGeo;
    const setGeoState = field === 'origin' ? setOriginGeo : setDestGeo;
    const setCoord = field === 'origin' ? setOriginCoord : setDestCoord;
    const seqRef = field === 'origin' ? originRequestSeq : destRequestSeq;

    // Same text as the last attempt (success or failure) — don't burn quota re-requesting it
    if (geoState.text === trimmed && (geoState.status === 'resolved' || geoState.status === 'error')) {
      return geoState.status === 'resolved';
    }

    const mySeq = ++seqRef.current;
    setGeoState({ text: trimmed, status: 'loading', error: '', source: null });

    try {
      const result = await geocode(trimmed);
      if (seqRef.current !== mySeq) return false; // superseded by a newer drag/geocode request
      setCoord({ lat: result.lat, lng: result.lng });
      setGeoState({ text: trimmed, status: 'resolved', error: '', source: 'geocode' });
      return true;
    } catch (err) {
      if (seqRef.current !== mySeq) return false;
      setCoord(null);
      setGeoState({ text: trimmed, status: 'error', error: (err as Error).message, source: null });
      return false;
    }
  };

  // Reverse-geocodes a dropped marker position, updates the field's text (without routing
  // through handleTextAnswerChange, so this never triggers a redundant forward re-geocode),
  // and rebuilds the route if a plan already exists. Reverts the marker on an invalid drop.
  const handleMarkerDragEnd = async (field: 'origin' | 'dest', lat: number, lng: number) => {
    const setGeoState = field === 'origin' ? setOriginGeo : setDestGeo;
    const setCoord = field === 'origin' ? setOriginCoord : setDestCoord;
    const seqRef = field === 'origin' ? originRequestSeq : destRequestSeq;
    const previousCoord = field === 'origin' ? originCoord : destCoord;
    const previousGeo = field === 'origin' ? originGeo : destGeo;

    const mySeq = ++seqRef.current;
    setCoord({ lat, lng }); // show the dropped pin immediately while we confirm/label it
    setGeoState(prev => ({ ...prev, status: 'loading' }));

    try {
      const result = await reverseGeocode(lat, lng);
      if (seqRef.current !== mySeq) return; // superseded by a newer drag/geocode request

      setGeoState({ text: result.name, status: 'resolved', error: '', source: 'drag' });
      setAnswers(prev => ({ ...prev, [field]: result.name }));

      if (phase === 'plan') {
        const dragCoord = { lat, lng };
        if (field === 'origin') {
          startGeneration(dragCoord, destCoord ?? TRIP_DEST);
        } else {
          startGeneration(originCoord ?? TRIP_ORIGIN, dragCoord);
        }
      }
    } catch (err) {
      if (seqRef.current !== mySeq) return;

      setCoord(previousCoord ? { ...previousCoord } : null); // snap the marker back
      setGeoState(previousGeo);
      setMessages(prev => [...prev, {
        id: `reverse-geocode-error-${Date.now()}`,
        sender: 'bot',
        text: `${(err as Error).message} Маркер возвращён на прежнее место.`
      }]);
    }
  };

  // Map click while in picking mode places the point for whichever field is being picked,
  // then exits picking mode. Reuses handleMarkerDragEnd — clicking is just another way of
  // dropping a pin, so it gets the same Colorado check / reverse-geocode / rebuild behavior.
  const handleMapClick = (lat: number, lng: number) => {
    if (!pickingField) return;
    const field = pickingField;
    setPickingField(null);
    handleMarkerDragEnd(field, lat, lng);
  };

  const handleNextQuiz = async () => {
    setPickingField(null); // leaving this step — don't let a stray click land on it later
    const rawVal = answers[currentQuestion.k];
    const isLocationStep = currentQuestion.k === 'origin' || currentQuestion.k === 'dest';

    // Save or fallback to default if empty and has a default
    if (!rawVal && currentQuestion.def) {
      setAnswers(prev => ({ ...prev, [currentQuestion.k]: currentQuestion.def || '' }));
    }

    if (isLocationStep) {
      const text = typeof rawVal === 'string' && rawVal.trim() !== '' ? rawVal : (currentQuestion.def as string | undefined) || '';
      setQuizNextLoading(true);
      const ok = await resolveFieldCoords(currentQuestion.k as 'origin' | 'dest', text);
      setQuizNextLoading(false);
      if (!ok) return; // stay on step; inline error is shown under the field
    }

    if (step < QUIZ.length - 1) {
      setStep(prev => prev + 1);
    } else {
      startRefinement();
    }
  };

  const handlePrevQuiz = () => {
    setPickingField(null); // leaving this step — don't let a stray click land on it later
    if (step > 0) {
      setStep(prev => prev - 1);
    }
  };

  // Restores a draft fetched from the server (see resumableTrip/the
  // "Продолжить поездку" banner) exactly as it was — unlike the old
  // localStorage version, this does NOT regenerate the route live from
  // scratch (which used to silently reset custom checkbox toggles back to
  // the suggested set). options/includedByOption/routeThroughByOption come
  // straight from draft_state, so the restored plan is byte-for-byte what
  // was last autosaved. Google detail-route and Gemini enrichment were never
  // in the draft (see TripProject.draft_state) — those just come back empty,
  // same as a freshly built route that hasn't been detailed/enriched yet.
  const handleRestoreDraft = (trip: TripProject) => {
    setPickingField(null);
    setTripProjectId(trip.id);
    setTripTitle(trip.title || 'Новая поездка');
    setIsTitleManuallyEdited(true);
    setAnswers((trip.quiz_answers as Record<string, QuizAnswerValue>) || {});
    setOriginGeo(EMPTY_GEO_STATE);
    setDestGeo(EMPTY_GEO_STATE);
    originRequestSeq.current += 1;
    destRequestSeq.current += 1;

    const draft = (trip.draft_state || {}) as Partial<DraftStateSnapshot>;
    const restoredOptions = draft.options ?? [];
    const restoredActiveIndex = draft.activeOptionIndex ?? 0;
    const restoredIncluded = new Map<number, Set<number>>(
      (draft.includedByOption ?? []).map(([idx, ids]) => [idx, new Set(ids)])
    );
    const restoredThrough = new Map<number, RouteThroughSummary>(draft.routeThroughByOption ?? []);

    setOptions(restoredOptions);
    setActiveOptionIndex(restoredActiveIndex);
    setIncludedByOption(restoredIncluded);
    setRouteThroughByOption(restoredThrough);
    setDetailedByOption(new Map());
    setDetailLoadingOptionIndex(null);
    setEnrichedByOption(new Map());
    setEnrichLoadingOptionIndex(null);
    setLoadingOptionIndex(null);
    routeThroughAbortRef.current?.abort();
    setSelectedStopId(null);
    setRouteOrigin(draft.routeOrigin ?? null);
    setRouteDest(draft.routeDest ?? null);
    setOriginCoord(draft.routeOrigin ?? null);
    setDestCoord(draft.routeDest ?? null);
    setRouteLine([]);
    setShowDateModal(false);

    const primaryIncluded = restoredIncluded.get(restoredActiveIndex)?.size ?? 0;
    setMessages([{
      id: 'plan-bot-restored',
      sender: 'bot',
      text: restoredOptions.length > 0
        ? `Поездка восстановлена${restoredOptions.length > 1 ? `: ${restoredOptions.length} варианта` : ''}. В активном варианте ${primaryIncluded} остановок включено.`
        : 'Черновик восстановлен.',
    }]);

    setPhase('plan');
    setResumableTrip(null);
    setResumeBannerDismissed(true);
    setSaveState('saved');
  };

  // Reset function to start new trip
  const resetAllToNewQuiz = () => {
    setPhase('quiz');
    setStep(0);
    setAnswers({});
    setMessages([]);
    setInputText('');
    setOptions([]);
    setActiveOptionIndex(0);
    setIncludedByOption(new Map());
    setRouteThroughByOption(new Map());
    setLoadingOptionIndex(null);
    setDetailedByOption(new Map());
    setDetailLoadingOptionIndex(null);
    setEnrichedByOption(new Map());
    setEnrichLoadingOptionIndex(null);
    setShowDateModal(false);
    setSelectedStopId(null);
    routeThroughAbortRef.current?.abort();
    setRouteOrigin(null);
    setRouteDest(null);
    pendingOptionsRef.current = null;
    setRouteLine([]);
    setOriginCoord(null);
    setDestCoord(null);
    setOriginGeo(EMPTY_GEO_STATE);
    setDestGeo(EMPTY_GEO_STATE);
    // Invalidate any in-flight geocode/drag requests from the trip being reset
    originRequestSeq.current += 1;
    destRequestSeq.current += 1;
    setGenerationStep(0);
    setDetourSummary('');
    setTripProjectId(null);
    setTripTitle('Новая поездка');
    setIsTitleManuallyEdited(false);
    setSaveState('saved');
  };

  // Confirm and start a new trip
  const handleNewTripClick = () => {
    // A built route is autosaved, but once "new trip" replaces it, the old
    // draft stops being the one /trips/current (and the resume banner) would
    // offer — confirm before quietly making it unreachable this session.
    if (phase !== 'quiz') {
      setShowConfirmNewTrip(true);
    } else {
      resetAllToNewQuiz();
    }
  };

  // Start Refinement Phase
  const startRefinement = () => {
    setPhase('refine');

    // Default value helpers
    const currentAnswers = { ...answers };
    if (!currentAnswers.origin) currentAnswers.origin = 'Денвер';
    if (!currentAnswers.dest) currentAnswers.dest = 'Лас-Вегас';
    if (!currentAnswers.days) currentAnswers.days = '5–6';
    if (!currentAnswers.drive) currentAnswers.drive = 'до 4 ч';
    if (!currentAnswers.detour) currentAnswers.detour = 'до 300 мин';
    if (!currentAnswers.pace) currentAnswers.pace = 'спокойный';
    setAnswers(currentAnswers);

    setDetourSummary((currentAnswers.detour as string) || 'до 30 мин');

    const interestsStr = (currentAnswers.interests as string[] || ['каньоны']).join(', ');
    const userPromptText = `Я хочу спланировать поездку из ${currentAnswers.origin} в ${currentAnswers.dest} на ${currentAnswers.days} дней. Люблю ${interestsStr}. Не хочу ехать больше ${((currentAnswers.drive as string) || 'до 4 ч').replace('до ', '')} в день, готов на крюк ${currentAnswers.detour || 'до 30 мин'}. Темп ${currentAnswers.pace || 'спокойный'}.${currentAnswers.avoid ? ' Исключить: ' + currentAnswers.avoid + '.' : ''}`;

    const botWelcomeText = 'Так я понял вашу поездку. Можно уточнить в чате — например, добавить обязательное место или поменять лимиты. Когда готовы, нажмите «Построить маршрут».';

    setMessages([
      { id: 'refine-user-init', sender: 'user', text: userPromptText },
      { id: 'refine-bot-init', sender: 'bot', text: botWelcomeText }
    ]);

    // No autosave here on purpose — the trigger list is "построение маршрута,
    // переключение варианта, вкл/выкл остановки" (see the debounced autosave
    // effect below), all of which only happen once options exist in 'plan'.
    // Nothing worth persisting exists yet at 'refine'.
  };

  // Step 1 of Finalize: not authenticated -> sign-in modal, remembering to
  // resume straight into the free preview once login succeeds. Already
  // authenticated -> skip straight to that preview (see startFinalizePreview
  // — the balance check moved AFTER the lodging picker, not before it).
  const handleFinalizeClick = () => {
    setAuthModalError(null);
    if (!authState.authenticated) {
      setPendingAuthAction('finalize');
      setShowFinalizeModal(true);
      return;
    }
    startFinalizePreview();
  };

  // Step 1 (continued): free, never charges a credit. Saves the draft first
  // (same "give finalize-preview the latest checkboxes" reasoning as
  // handleConfirmFinalize below) so the preview's day split reflects
  // whatever's actually included right now, not a stale autosave.
  const startFinalizePreview = () => {
    if (!tripProjectId) return;
    setFinalizePreviewLoading(true);
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    saveDraftNow()
      .then(() => postFinalizePreview(tripProjectId))
      .then(preview => {
        setFinalizePreviewLoading(false);
        setFinalizePreview(preview);
        if (preview.needs_selection) {
          setShowLodgingModal(true);
        } else {
          setSelectedLodging(null);
          openFinalizeGate();
        }
      })
      .catch(err => {
        console.error('Failed to fetch finalize preview:', err);
        setFinalizePreviewLoading(false);
        setMessages(prev => [...prev, {
          id: `finalize-preview-error-${Date.now()}`,
          sender: 'bot',
          text: 'Не удалось подготовить финализацию. Попробуйте ещё раз.',
        }]);
      });
  };

  const handleLodgingContinue = (chosen: SelectedLodging[]) => {
    setSelectedLodging(chosen);
    setShowLodgingModal(false);
    openFinalizeGate();
  };

  const handleLodgingSkip = () => {
    setSelectedLodging(null);
    setShowLodgingModal(false);
    openFinalizeGate();
  };

  // Closes the picker without proceeding to payment at all — a full cancel
  // of this Finalize attempt, distinct from "Пропустить" (which still heads
  // to the paywall/confirm step, just without lodging waypoints).
  const handleLodgingCancel = () => {
    setShowLodgingModal(false);
    setFinalizePreview(null);
  };

  const handleLoginClick = () => {
    setAuthModalError(null);
    setPendingAuthAction(null);
    setShowFinalizeModal(true);
  };

  // GoogleSignInButton's callback — `credential` is the raw ID token (JWT),
  // never trusted here: /auth/google verifies it against Google's own public
  // keys before doing anything (auth.py). On success the session's cookie is
  // unchanged (same anonymous session, now claimed — see auth.py's claim
  // logic), so phase/options/tripProjectId all stay exactly as they were:
  // the user lands back on the same 'plan' screen with the same trip, never
  // an empty dashboard.
  const handleGoogleCredential = (credential: string) => {
    loginWithGoogle(credential)
      .then(result => {
        setAuthState({ authenticated: true, email: result.email });
        setShowFinalizeModal(false);
        setAuthModalError(null);
        if (pendingAuthAction === 'finalize') {
          setPendingAuthAction(null);
          startFinalizePreview();
        }
      })
      .catch(err => {
        console.error('Google sign-in failed:', err);
        setAuthModalError('Не удалось войти. Попробуйте ещё раз.');
      });
  };

  const handleLogoutClick = () => {
    logout()
      .then(() => setAuthState({ authenticated: false, email: null }))
      .catch(err => console.error('Logout failed:', err));
  };

  // Header's "Мои поездки" — needs a real account (the list is by
  // owner_user_id, an anonymous session has no list, only "the current
  // draft"). Not signed in yet -> same sign-in modal Finalize/"Войти" use.
  const handleMyTripsClick = () => {
    if (!authState.authenticated) {
      setAuthModalError(null);
      setPendingAuthAction(null);
      setShowFinalizeModal(true);
      return;
    }
    setShowMyTripsModal(true);
  };

  // "Мои поездки" opens a draft the same way the "Продолжить поездку" banner
  // does (handleRestoreDraft — same draft_state shape, same exact-restore
  // guarantee). A finalized trip opens the read-only view instead (Фаза 3,
  // подшаг 3) — same trip_project, different data source (trip_versions
  // snapshot, not draft_state), so it's a genuinely different code path, not
  // a variant of the same one.
  const handleOpenTripFromList = (id: string, status: string) => {
    setShowMyTripsModal(false);
    if (status === 'finalized') {
      handleOpenFinalizedFromList(id);
      return;
    }
    getTrip(id)
      .then(trip => handleRestoreDraft(trip))
      .catch(err => console.error('Failed to open trip:', err));
  };

  const handleDeleteTripFromList = (id: string) => {
    deleteTrip(id)
      .then(() => setMyTrips(prev => prev.filter(t => t.id !== id)))
      .catch(err => console.error('Failed to delete trip:', err));
  };

  // Step 2: balance check. balance>=1 -> straight to the confirm screen (with
  // a fresh idempotency key for this attempt); balance=0 -> paywall dead end.
  const openFinalizeGate = () => {
    setFinalizeGateError(null);
    getCredits()
      .then(result => {
        setCredits(result);
        if (result.balance >= 1) {
          setFinalizeIdempotencyKey(crypto.randomUUID());
          setFinalizeGateStage('confirm');
        } else {
          setFinalizeGateStage('paywall');
        }
      })
      .catch(err => {
        console.error('Failed to fetch credits:', err);
        setFinalizeGateError('Не удалось проверить баланс. Попробуйте ещё раз.');
      });
  };

  const handleCloseFinalizeGate = () => {
    if (finalizeSubmitting) return; // ignore stray closes mid-request
    setFinalizeGateStage(null);
    setFinalizeGateError(null);
  };

  // Step 4: spend the credit. Saves the draft first (bypassing the 1.5s
  // autosave debounce — Finalize reads trip_project.draft_state straight
  // from the DB, see finalize.py, so a toggle from a second ago must already
  // be there) and reuses the SAME idempotency key across retries within this
  // one confirm-screen visit (see finalizeIdempotencyKey's own comment).
  const handleConfirmFinalize = () => {
    if (finalizeSubmitting || !finalizeIdempotencyKey || !tripProjectId) return;
    setFinalizeSubmitting(true);
    setFinalizeGateError(null);

    const idKey = finalizeIdempotencyKey;
    const tripId = tripProjectId;
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }

    saveDraftNow()
      // saveDraftNow never rejects (see its own comment) — even a failed save
      // still leaves the last successfully-saved draft_state for Finalize to
      // read, so proceeding here regardless is intentional, not a swallowed bug.
      .then(() => postFinalizeTrip(tripId, idKey, selectedLodging))
      .then(result => {
        setFinalizeSubmitting(false);
        setFinalizeGateStage(null);
        setSelectedStopId(null);
        setFinalizeJobId(result.job_id);
        setPhase('finalizing');
        startFinalizePolling(result.job_id, tripId);
      })
      .catch(err => {
        console.error('Failed to start finalize:', err);
        setFinalizeSubmitting(false);
        setFinalizeGateError((err as Error).message || 'Не удалось запустить финализацию. Попробуйте ещё раз.');
      });
  };

  const stopFinalizePolling = () => {
    if (finalizePollRef.current) {
      clearInterval(finalizePollRef.current);
      finalizePollRef.current = null;
    }
  };

  // Step 5: poll every ~2s. pending/processing just keep polling — the
  // animated stage labels in FinalizeProgress are cosmetic, this status is
  // the only real signal (see finalize.py: 14-19s total for Google+Gemini).
  const startFinalizePolling = (jobId: string, tripId: string) => {
    stopFinalizePolling();
    finalizePollRef.current = setInterval(() => {
      getFinalizeStatus(jobId)
        .then(status => {
          if (status.status === 'done') {
            stopFinalizePolling();
            loadFinalizedResult(tripId);
          } else if (status.status === 'failed') {
            stopFinalizePolling();
            handleFinalizeJobFailed(status.error);
          }
        })
        .catch(err => console.error('Failed to poll finalize status:', err));
    }, 2000);
  };

  // Step 6 (success): load the self-contained snapshot and show it.
  // is_first_finalize comes straight off this response (see finalize.py) —
  // no separate round trip needed just to decide the welcome modal.
  const loadFinalizedResult = (tripId: string) => {
    getFinalizedTrip(tripId)
      .then(result => {
        setFinalizedTrip(result);
        setOriginCoord({ lat: result.origin.lat, lng: result.origin.lon });
        setDestCoord({ lat: result.destination.lat, lng: result.destination.lon });
        setFinalizeJobId(null);
        // This attempt's lodging pick is spent — clear it so a LATER
        // finalize (re-finalizing this same trip, or a different one)
        // starts from a fresh preview, not a stale selection.
        setFinalizePreview(null);
        setSelectedLodging(null);
        setPhase('finalized');
        if (result.is_first_finalize) {
          setShowWelcomeModal(true);
        }
        // Balance just changed (charged) — best-effort refresh for anywhere
        // it's displayed; failure here doesn't affect the result shown above.
        getCredits().then(setCredits).catch(() => {});
      })
      .catch(err => {
        console.error('Failed to load finalized trip:', err);
        setFinalizeGateError('Поездка финализирована, но результат не загрузился. Загляните в «Мои поездки».');
        setPhase('plan');
      });
  };

  // Step 6 (failure): the backend has already refunded by the time 'failed'
  // is observable here (process_finalization's refund happens before the job
  // row is updated) — this just reflects that back, softly, and returns to
  // the draft, which was never touched.
  const handleFinalizeJobFailed = (error: string | null) => {
    setFinalizeJobId(null);
    setFinalizePreview(null);
    setSelectedLodging(null);
    setPhase('plan');
    getCredits().then(setCredits).catch(() => {});
    setMessages(prev => [...prev, {
      id: `finalize-failed-${Date.now()}`,
      sender: 'bot',
      text: 'Не удалось финализировать поездку — кредит возвращён. Можно попробовать ещё раз.',
    }]);
    console.error('Finalize job failed:', error);
  };

  // "Мои поездки" -> a finalized card's "Смотреть финал".
  const handleOpenFinalizedFromList = (id: string) => {
    getFinalizedTrip(id)
      .then(result => {
        setTripProjectId(id);
        setFinalizedTrip(result);
        setOriginCoord({ lat: result.origin.lat, lng: result.origin.lon });
        setDestCoord({ lat: result.destination.lat, lng: result.destination.lon });
        setSelectedStopId(null);
        setPhase('finalized');
      })
      .catch(err => console.error('Failed to open finalized trip:', err));
  };

  // FinalizedView's "Редактировать черновик" — the SAME trip_project's
  // draft_state, independent of (and untouched by) the finalized snapshot
  // just shown; edits here never alter the finalized version already saved.
  const handleEditDraftFromFinalized = () => {
    if (!tripProjectId) return;
    getTrip(tripProjectId)
      .then(trip => handleRestoreDraft(trip))
      .catch(err => console.error('Failed to open draft:', err));
  };

  // Enters the 'plan' phase with the fetched route options: seeds per-option
  // included-stop sets from `suggested`, seeds per-option through-route results from
  // whatever compare_routes already computed server-side (no redundant /route-through
  // calls), and persists the active (first) option as the trip's saved plan.
  const enterPlan = (
    opts: RouteOption[],
    origin: { lat: number; lng: number },
    dest: { lat: number; lng: number }
  ) => {
    const initialIncluded = new Map<number, Set<number>>();
    const initialThrough = new Map<number, RouteThroughSummary>();
    opts.forEach((option, idx) => {
      initialIncluded.set(idx, new Set(option.stops.filter(s => s.suggested).map(s => s.id)));
      if (option.through_shape && option.total_s != null && option.delta_s != null) {
        initialThrough.set(idx, {
          total_s: option.total_s,
          delta_s: option.delta_s,
          through_shape: option.through_shape,
        });
      }
    });

    setOptions(opts);
    setActiveOptionIndex(0);
    setIncludedByOption(initialIncluded);
    setRouteThroughByOption(initialThrough);
    setSelectedStopId(null);
    setPhase('plan');

    const primaryIncluded = initialIncluded.get(0)?.size ?? 0;
    const botReadyText = opts.length > 0
      ? `Маршрут готов${opts.length > 1 ? `: ${opts.length} варианта` : ''}. В первом варианте ${primaryIncluded} остановок включено.`
      : 'Не удалось построить маршрут по этим условиям.';
    setMessages([{ id: 'plan-bot-init', sender: 'bot', text: botReadyText }]);
    // Autosave picks this up on its own — see the debounced effect below,
    // which watches options/activeOptionIndex/includedByOption and fires
    // once options just went from empty to populated, exactly as here.
  };

  // Start Generation Phase. Accepts coordinate + answers overrides so a marker drag or
  // a saved-trip reload can trigger a rebuild without waiting for a re-render to land
  // in originCoord/destCoord/answers state (which this closure would otherwise read stale).
  const startGeneration = (
    originOverride?: { lat: number; lng: number } | null,
    destOverride?: { lat: number; lng: number } | null,
    answersOverride?: Record<string, QuizAnswerValue>
  ) => {
    setPhase('generating');
    setGenerationStep(0);

    const botGeneratingText = 'Строю маршрут. Каждая точка проверяется по реальной дорожной сети.';
    setMessages(prev => [...prev, { id: `gen-bot-${Date.now()}`, sender: 'bot', text: botGeneratingText }]);

    const origin = originOverride ?? originCoord ?? TRIP_ORIGIN;
    const dest = destOverride ?? destCoord ?? TRIP_DEST;
    const effectiveAnswers = answersOverride ?? answers;

    setOptions([]);
    setActiveOptionIndex(0);
    setIncludedByOption(new Map());
    setRouteThroughByOption(new Map());
    setLoadingOptionIndex(null);
    setDetailedByOption(new Map());
    setDetailLoadingOptionIndex(null);
    setEnrichedByOption(new Map());
    setEnrichLoadingOptionIndex(null);
    setShowDateModal(false);
    setSelectedStopId(null);
    routeThroughAbortRef.current?.abort();
    setRouteOrigin(origin);
    setRouteDest(dest);
    setRouteLine([]);
    pendingOptionsRef.current = null;
    animationDoneRef.current = false;
    generationTransitionedRef.current = false;

    // Rendezvous: the fetch (getCompareRoutes below) and the fixed-duration progress
    // animation (the setInterval below) are two independent async chains. Whichever
    // finishes SECOND calls this, and it only actually transitions once both sides
    // are ready — this removes any assumption about which one is faster.
    const tryFinishGeneration = () => {
      if (generationTransitionedRef.current) return;
      if (!animationDoneRef.current) return;
      const opts = pendingOptionsRef.current;
      if (opts === null) return; // fetch hasn't resolved yet
      generationTransitionedRef.current = true;
      enterPlan(opts, origin, dest);
    };

    getCompareRoutes({
      origin: { lat: origin.lat, lon: origin.lng },
      destination: { lat: dest.lat, lon: dest.lng },
      categories: mapInterestsToCategories(effectiveAnswers.interests as string[] | undefined),
      max_detour_s: mapDetourToMaxDetourS(effectiveAnswers.detour as string | undefined),
      pace: mapPaceToApiPace(effectiveAnswers.pace as string | undefined),
    })
      .then(result => {
        pendingOptionsRef.current = result.options;
        // Live preview line for the remainder of the generating animation
        const primary = result.options[0];
        if (primary) {
          setRouteLine(decodeShape(primary.route_shape));
        }
        tryFinishGeneration();
      })
      .catch(err => {
        console.error('Failed to fetch route comparison:', err);
        pendingOptionsRef.current = [];
        tryFinishGeneration();
      });

    // Sequential timing simulation matching the HTML prototype — this is a minimum
    // display duration for the progress steps, NOT what triggers the phase change
    // (see tryFinishGeneration above).
    let currentStep = 0;
    const interval = setInterval(() => {
      currentStep += 1;
      if (currentStep <= 5) {
        setGenerationStep(currentStep);
      } else {
        clearInterval(interval);
        setTimeout(() => {
          animationDoneRef.current = true;
          tryFinishGeneration();
        }, 600);
      }
    }, 550);
  };

  // Chat Responses State Machine
  const handleSendText = (textToSend: string) => {
    const text = textToSend.trim();
    if (!text) return;

    const userMsg: ChatMessage = {
      id: `user-chat-${Date.now()}`,
      sender: 'user',
      text: text
    };

    setMessages(prev => [...prev, userMsg]);
    setInputText('');

    // Trigger bot response after 450ms
    setTimeout(() => {
      respondToChat(text.toLowerCase());
    }, 450);
  };

  const respondToChat = (text: string) => {
    let botReplyText = 'Понял. Что-то ещё уточнить?';

    if (phase === 'refine') {
      setSaveState('unsaved');
      if (text.includes('моаб')) {
        botReplyText = 'Добавил Моаб как обязательную точку. Учту при построении.';
      } else if (text.includes('ребён') || text.includes('ребен')) {
        botReplyText = 'Учёл: с вами ребёнок. Сокращу длинные переезды и добавлю остановки с активностями.';
      } else if (text.includes('хайк') || text.includes('миль')) {
        botReplyText = 'Ограничил пешие маршруты двумя милями. Длинные тропы исключу.';
      } else {
        botReplyText = 'Учёл. Что-то ещё уточнить перед построением?';
      }
    } else if (phase === 'plan') {
      setSaveState('unsaved');
      botReplyText = 'Изменить состав остановок можно в списке справа от карты — там же виден пересчитанный крюк.';
    }

    setMessages(prev => [...prev, {
      id: `bot-reply-${Date.now()}`,
      sender: 'bot',
      text: botReplyText
    }]);
  };

  // Selects a stop marker/row — just pans the map, doesn't change checkbox state.
  const handleSelectStop = (id: number) => {
    setSelectedStopId(id);
  };

  // Recomputes the through-route for the given option's included stops. `optionIndex`
  // is captured explicitly (not read from activeOptionIndex at resolve time) so that
  // if the user has since switched tabs, the result still lands on the option it was
  // actually requested for. Cancels any in-flight /route-through request first, same
  // as before — a fast double-click can't have an older response land after a newer one.
  const recomputeRouteThrough = (
    optionIndex: number,
    stopIds: Set<number>,
    stopsList: ApiStop[],
    origin: { lat: number; lng: number },
    dest: { lat: number; lng: number }
  ) => {
    routeThroughAbortRef.current?.abort();
    const controller = new AbortController();
    routeThroughAbortRef.current = controller;

    const orderedStops = stopsList
      .filter(s => stopIds.has(s.id))
      .sort((a, b) => a.to_poi_s - b.to_poi_s);

    setLoadingOptionIndex(optionIndex);
    postRouteThrough(
      {
        origin: { lat: origin.lat, lon: origin.lng },
        destination: { lat: dest.lat, lon: dest.lng },
        stops: orderedStops.map(s => ({ lat: s.lat, lon: s.lon })),
      },
      controller.signal
    )
      .then(result => {
        setRouteThroughByOption(prev => {
          const next = new Map(prev);
          next.set(optionIndex, {
            total_s: result.total_s,
            delta_s: result.delta_s,
            through_shape: result.route_shape,
          });
          return next;
        });
        setLoadingOptionIndex(current => (current === optionIndex ? null : current));
      })
      .catch(err => {
        if (err?.name === 'AbortError') return; // superseded by a newer toggle
        console.error('Failed to recompute route through stops:', err);
        setLoadingOptionIndex(current => (current === optionIndex ? null : current));
      });
  };

  // Toggles a stop's inclusion for the ACTIVE option only — other options' checkbox
  // state is untouched, so switching tabs and back preserves whatever was edited.
  const handleToggleStop = (stopId: number) => {
    const optionIndex = activeOptionIndex;
    const current = includedByOption.get(optionIndex) ?? new Set<number>();
    const next = new Set<number>(current);
    if (next.has(stopId)) {
      next.delete(stopId);
    } else {
      next.add(stopId);
    }

    setIncludedByOption(prev => {
      const updated = new Map(prev);
      updated.set(optionIndex, next);
      return updated;
    });

    // The checkbox set changed, so any Google detail already fetched for this
    // option is now stale (it was computed for the OLD stop set) — drop it. The
    // UI falls back to the Valhalla estimate and "Детализировать" becomes
    // available again for this option.
    setDetailedByOption(prev => {
      if (!prev.has(optionIndex)) return prev;
      const updated = new Map(prev);
      updated.delete(optionIndex);
      return updated;
    });

    // Same reasoning for enrichment — it was written for the old stop set (and
    // the old Google numbers), so it's stale the instant the checkboxes change.
    // Dropping it also hides the enrichment text and re-shows "Рассказать о
    // маршруте" only once detailing has been redone (the button's own gating).
    setEnrichedByOption(prev => {
      if (!prev.has(optionIndex)) return prev;
      const updated = new Map(prev);
      updated.delete(optionIndex);
      return updated;
    });

    if (routeOrigin && routeDest) {
      const stopsList = options[optionIndex]?.stops ?? [];
      recomputeRouteThrough(optionIndex, next, stopsList, routeOrigin, routeDest);
    }
  };

  // Точка входа отключена до Фазы 3, запускается через Finalize — this and
  // handleConfirmEnrich below are NOT called from the UI anymore (see
  // PlanPanel's single "Финализировать поездку" button, wired to
  // handleFinalizeClick instead). Both functions, detailedByOption/
  // enrichedByOption state, and PlanPanel's day-grouping/enrichment-card
  // rendering are left fully intact — Finalize reuses this exact code path
  // after a real credit charge, it just isn't reachable for free anymore.
  //
  // Fetches exact Google Directions numbers for the active option's currently
  // included stops. `optionIndex` is captured at call time (same pattern as
  // recomputeRouteThrough) so a tab switch while the request is in flight can't
  // make the response land on the wrong option.
  const handleDetailize = () => {
    if (!routeOrigin || !routeDest) return;
    const optionIndex = activeOptionIndex;
    const included = includedByOption.get(optionIndex) ?? new Set<number>();
    const stopsList = options[optionIndex]?.stops ?? [];
    const orderedStops = stopsList
      .filter(s => included.has(s.id))
      .sort((a, b) => a.to_poi_s - b.to_poi_s);

    setDetailLoadingOptionIndex(optionIndex);
    postDetailRoute({
      origin: { lat: routeOrigin.lat, lon: routeOrigin.lng },
      destination: { lat: routeDest.lat, lon: routeDest.lng },
      stops: orderedStops.map(s => ({ lat: s.lat, lon: s.lon })),
      daily_limit_s: mapDriveToDailyLimitS(answers.drive as string | undefined),
      planned_days: typeof answers.days === 'number' ? answers.days : null,
      flexible_days: !!answers.flexible_days,
    })
      .then(result => {
        setDetailedByOption(prev => {
          const updated = new Map(prev);
          updated.set(optionIndex, result);
          return updated;
        });
        setDetailLoadingOptionIndex(current => (current === optionIndex ? null : current));
      })
      .catch(err => {
        console.error('Failed to fetch Google Directions detail:', err);
        setDetailLoadingOptionIndex(current => (current === optionIndex ? null : current));
      });
  };

  const handleOpenEnrichModal = () => {
    setShowDateModal(true);
  };

  // Fetches Gemini enrichment for the active option's currently included stops
  // (same set just used for /detail-route, in the same order). optionIndex is
  // captured at call time — same reasoning as handleDetailize — so a tab switch
  // mid-request can't land the response on the wrong option.
  const handleConfirmEnrich = (tripDates: string | null) => {
    setShowDateModal(false);
    const optionIndex = activeOptionIndex;
    const detail = detailedByOption.get(optionIndex);
    if (!detail) return; // the button is only shown once this exists, but stay defensive

    const included = includedByOption.get(optionIndex) ?? new Set<number>();
    const stopsList = options[optionIndex]?.stops ?? [];
    const orderedStops = stopsList
      .filter(s => included.has(s.id))
      .sort((a, b) => a.to_poi_s - b.to_poi_s);

    setEnrichLoadingOptionIndex(optionIndex);
    postEnrichRoute({
      origin_name: originVal || 'Денвер',
      destination_name: destVal || 'Дуранго',
      trip_dates: tripDates,
      // All numbers here are Google's exact figures from the detail this option
      // already has — never re-derived, never estimated, so the DTO Gemini sees
      // matches exactly what the UI is showing the user.
      total_duration_s: detail.duration_s,
      baseline_duration_s: detail.baseline_s,
      delta_s: detail.delta_s,
      distance_km: detail.distance_km,
      stops: orderedStops.map(s => ({
        id: s.id,
        name: s.name,
        category: s.category,
        rating: s.rating,
        review_count: s.review_count,
        detour_s: s.detour_s,
        duration_raw: s.duration,
        about: s.about,
        website: s.website,
      })),
    })
      .then(result => {
        setEnrichedByOption(prev => {
          const updated = new Map(prev);
          updated.set(optionIndex, result);
          return updated;
        });
        setEnrichLoadingOptionIndex(current => (current === optionIndex ? null : current));
      })
      .catch(err => {
        console.error('Failed to fetch route enrichment:', err);
        setEnrichLoadingOptionIndex(current => (current === optionIndex ? null : current));
      });
  };

  // Origin & destination header labels
  const originVal = answers.origin ? (Array.isArray(answers.origin) ? answers.origin[0] : answers.origin) : '';
  const destVal = answers.dest ? (Array.isArray(answers.dest) ? answers.dest[0] : answers.dest) : '';

  // Map overlay. Two independent sources depending on phase:
  // - 'finalized': the immutable snapshot (finalizedTrip) — one route, no
  //   alternatives, day segments/markers straight from snapshot.days.
  // - everything else ('plan'/'finalizing', which keeps showing the plan
  //   overlay underneath the progress screen — see MapComponent's phase
  //   comment): every option's base line, active one swapped for its
  //   through-route (the route actually taken with its included stops) so
  //   the highlighted line reflects the current checkbox state, not just the
  //   raw option. If that active option has been detailed via Google, its
  //   EXACT polyline wins over the Valhalla through-route — but it's
  //   precision 5, decoded with a different function (decodeGoogleShape),
  //   never decodeShape (precision 6, Valhalla-only).
  let planRouteLinesForMap: Array<{ points: { lat: number; lng: number }[]; isActive: boolean }>;
  let planMarkersForMap: Array<{ stop: ApiStop; included: boolean; order: number | null }>;
  let activeDaySegments: Array<{ points: { lat: number; lng: number }[]; color: string }> = [];
  let dayBoundaryMarkersForMap: Array<{ position: { lat: number; lng: number }; color: string; label: string }> = [];
  // Фаза ночёвок: only ever populated for 'finalized' — nothing is chosen
  // yet during the free draft.
  let lodgingMarkersForMap: Array<{ position: { lat: number; lng: number }; name: string }> = [];

  if (phase === 'finalized' && finalizedTrip) {
    const finOrigin = { lat: finalizedTrip.origin.lat, lng: finalizedTrip.origin.lon };
    const finDest = { lat: finalizedTrip.destination.lat, lng: finalizedTrip.destination.lon };
    const path = decodeGoogleShape(finalizedTrip.route.shape);
    planRouteLinesForMap = [{ points: path, isActive: true }];

    const orderByIdFinal = new Map(finalizedTrip.stops.map((s, i) => [s.id, i + 1]));
    // Padded to ApiStop's shape — about/website/duration were folded into
    // `why`/`tips` by enrichment and aren't in the snapshot; to_poi_s/
    // from_poi_s/suggested aren't used once a trip is finalized (no more
    // re-sorting or re-suggesting), only present so this satisfies the type
    // the map/popup already knows how to render.
    planMarkersForMap = finalizedTrip.stops.map(s => ({
      stop: {
        id: s.id, name: s.name, category: s.category, rating: s.rating, review_count: s.review_count,
        about: null, website: null, duration: null, lat: s.lat, lon: s.lon, detour_s: s.detour_s,
        to_poi_s: 0, from_poi_s: 0, suggested: false,
      },
      included: true,
      order: orderByIdFinal.get(s.id) ?? null,
    }));

    const waypoints = [finOrigin, ...finalizedTrip.stops.map(s => ({ lat: s.lat, lng: s.lon })), finDest];
    const legSegments = splitPathIntoLegs(path, waypoints);
    const stopIndexToDay = new Map<number, number>();
    finalizedTrip.days.forEach((day, dayIdx) => {
      day.stop_indices.forEach(si => stopIndexToDay.set(si, dayIdx));
    });
    const lastDayIdx = finalizedTrip.days.length - 1;

    activeDaySegments = legSegments.map((points, legIdx) => {
      const dayIdx = legIdx < finalizedTrip.stops.length
        ? stopIndexToDay.get(legIdx) ?? lastDayIdx
        : lastDayIdx;
      return { points, color: dayColor(dayIdx) };
    });

    dayBoundaryMarkersForMap = finalizedTrip.days.slice(1).map((day) => {
      const dayIdx = day.day - 1;
      const firstStop = finalizedTrip.stops[day.stop_indices[0]];
      return firstStop
        ? { position: { lat: firstStop.lat, lng: firstStop.lon }, color: dayColor(dayIdx), label: `Д${day.day}` }
        : null;
    }).filter((m): m is { position: { lat: number; lng: number }; color: string; label: string } => m != null);

    lodgingMarkersForMap = finalizedTrip.days
      .filter(day => day.lodging != null)
      .map(day => ({
        position: { lat: day.lodging!.lat, lng: day.lodging!.lon },
        name: day.lodging!.name,
      }));
  } else {
    planRouteLinesForMap = options.map((option, idx) => {
      const isActive = idx === activeOptionIndex;
      if (!isActive) {
        return { points: decodeShape(option.route_shape), isActive: false };
      }
      const detail = detailedByOption.get(idx);
      if (detail) {
        return { points: decodeGoogleShape(detail.shape), isActive: true };
      }
      const shape = routeThroughByOption.get(idx)?.through_shape ?? option.route_shape;
      return { points: decodeShape(shape), isActive: true };
    });

    const activeOption = options[activeOptionIndex];
    const activeIncludedForMap = includedByOption.get(activeOptionIndex) ?? new Set<number>();
    const includedSortedForMap = (activeOption?.stops ?? [])
      .filter(s => activeIncludedForMap.has(s.id))
      .sort((a, b) => a.to_poi_s - b.to_poi_s);
    const orderByIdForMap = new Map(includedSortedForMap.map((s, i) => [s.id, i + 1]));
    planMarkersForMap = (activeOption?.stops ?? []).map(stop => ({
      stop,
      included: activeIncludedForMap.has(stop.id),
      order: orderByIdForMap.get(stop.id) ?? null,
    }));

    // Day-colored route segments + boundary markers for the active option —
    // only exist once /detail-route has run (day_split needs Google's
    // per-leg times, see day_split.py). `includedSortedForMap` is the exact
    // same stop order sent to /detail-route (same included set, same
    // to_poi_s sort), so detail.days[i].stop_indices index straight into it.
    const activeDetailForMap = detailedByOption.get(activeOptionIndex);

    if (activeDetailForMap && routeOrigin && routeDest) {
      const waypoints = [
        routeOrigin,
        ...includedSortedForMap.map(s => ({ lat: s.lat, lng: s.lon })),
        routeDest,
      ];
      const path = decodeGoogleShape(activeDetailForMap.shape);
      const legSegments = splitPathIntoLegs(path, waypoints);

      const stopIndexToDay = new Map<number, number>();
      activeDetailForMap.days.forEach((day, dayIdx) => {
        day.stop_indices.forEach(si => stopIndexToDay.set(si, dayIdx));
      });
      const lastDayIdx = activeDetailForMap.days.length - 1;

      activeDaySegments = legSegments.map((points, legIdx) => {
        // A leg ending at a stop (legIdx < stop count) belongs to that stop's
        // day; the final leg (into dest, no stop) always belongs to the last
        // day — same "closes wherever it lands" rule as day_split.py itself.
        const dayIdx = legIdx < includedSortedForMap.length
          ? stopIndexToDay.get(legIdx) ?? lastDayIdx
          : lastDayIdx;
        return { points, color: dayColor(dayIdx) };
      });

      dayBoundaryMarkersForMap = activeDetailForMap.days.slice(1).map((day) => {
        const dayIdx = day.day - 1;
        const firstStop = includedSortedForMap[day.stop_indices[0]];
        return firstStop
          ? { position: { lat: firstStop.lat, lng: firstStop.lon }, color: dayColor(dayIdx), label: `Д${day.day}` }
          : null;
      }).filter((m): m is { position: { lat: number; lng: number }; color: string; label: string } => m != null);
    }
  }

  // Server autosave (Фаза 1, шаг 3). Debounced trigger list, exactly:
  // building the route (options going from empty to populated), switching
  // the active option tab, and toggling a stop's checkbox — plus renaming
  // the trip, which the user asked to have land in draft_state too. Nothing
  // fires before 'plan' — there's nothing worth persisting during quiz/refine.
  const buildDraftPayload = () => {
    const originVal = answers.origin ? (Array.isArray(answers.origin) ? answers.origin[0] : answers.origin) : null;
    const destVal = answers.dest ? (Array.isArray(answers.dest) ? answers.dest[0] : answers.dest) : null;

    const draftState: DraftStateSnapshot = {
      version: 1,
      options,
      activeOptionIndex,
      includedByOption: Array.from(includedByOption.entries()).map(([idx, set]) => [idx, Array.from(set)]),
      routeThroughByOption: Array.from(routeThroughByOption.entries()),
      routeOrigin,
      routeDest,
    };

    return {
      title: tripTitle,
      origin_name: typeof originVal === 'string' ? originVal : null,
      destination_name: typeof destVal === 'string' ? destVal : null,
      origin: routeOrigin ? { lat: routeOrigin.lat, lon: routeOrigin.lng } : null,
      destination: routeDest ? { lat: routeDest.lat, lon: routeDest.lng } : null,
      quiz_answers: answers as Record<string, unknown>,
      draft_state: draftState as unknown as Record<string, unknown>,
    };
  };

  // Returns the in-flight promise (not just fire-and-forget) so
  // handleConfirmFinalize can wait on a fresh save before POSTing finalize.
  // Deliberately swallows its own error here (not re-thrown) — the debounced
  // autosave effect below calls this directly as a setTimeout callback with
  // no .catch of its own, and an unswallowed rejection there would surface
  // as an unhandled-promise-rejection console warning on every failed
  // autosave. Existing effect-triggered callers simply don't use the return
  // value; handleConfirmFinalize only needs the resolution as a "give it a
  // moment" signal, not a success/failure result.
  const saveDraftNow = () => {
    setSaveState('saving');
    return saveTrip({
      trip_project_id: tripProjectId,
      ...buildDraftPayload(),
    })
      .then(result => {
        setTripProjectId(result.trip_project_id);
        setSaveState('saved');
      })
      .catch(err => {
        console.error('Failed to save draft:', err);
        setSaveState('unsaved');
      });
  };

  // routeThroughByOption MUST be a dependency here, not just includedByOption:
  // toggling a stop changes includedByOption synchronously (scheduling this
  // effect's setTimeout with a saveDraftNow closure over routeThroughByOption
  // AS IT WAS AT THAT RENDER — still the pre-recompute value, since
  // /route-through is an in-flight async call at that point). Without this
  // dependency, when recomputeRouteThrough's response later lands and updates
  // routeThroughByOption, nothing reschedules the pending save — the stale
  // closure fires anyway 1.5s after the TOGGLE, not after the recompute,
  // persisting yesterday's delta_s into draft_state (confirmed: restoring a
  // draft showed the delta from BEFORE the last checkbox change, not after).
  // Including it here means a routeThroughByOption update restarts the
  // debounce with a fresh closure, and self-heals even if the recompute
  // takes longer than 1.5s (a second effect run reschedules once it lands).
  useEffect(() => {
    if (phase !== 'plan' || options.length === 0) return;

    setSaveState('unsaved');
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(saveDraftNow, 1500);

    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [phase, options, activeOptionIndex, includedByOption, routeThroughByOption, tripTitle]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#22262b]">
      <Header
        tripTitle={tripTitle}
        saveState={saveState}
        onTitleChange={(newTitle) => {
          setTripTitle(newTitle);
          setIsTitleManuallyEdited(true);
        }}
        onNewTrip={handleNewTripClick}
        authenticated={authState.authenticated}
        userEmail={authState.email}
        onLoginClick={handleLoginClick}
        onLogoutClick={handleLogoutClick}
        onMyTripsClick={handleMyTripsClick}
      />

      <div className="app flex-1 min-h-0">
        {/* LEFT PANEL: Console Control Panel */}
        <div className="panel w-full md:w-[420px] md:min-w-[420px] h-[58vh] md:h-full bg-asphalt flex flex-col min-w-0 border-r border-[#000000]">

          <>
              {/* Dynamic Trip Summary Bar — trip title already lives in the header above
                  (TripHeader), so this block doesn't repeat it, only the parameters
                  that appear nowhere else in the UI. */}
              {/* Hidden for finalizing/finalized too — these can be reached directly
                  from "Мои поездки" (handleOpenFinalizedFromList) without ever
                  populating `answers` for that specific trip, so this bar would
                  otherwise show stale quiz params from whatever was open before. */}
              <div className={`summary ${['quiz', 'generating', 'finalizing', 'finalized'].includes(phase) ? 'hidden' : ''}`} id="summary">
                <div className="w-full text-[9px] uppercase tracking-wide text-[#5a5f66] font-mono mb-0.5">
                  Параметры поездки
                </div>
                <div>
                  дней
                  <b>
                    {typeof answers.days === 'number'
                      ? `${answers.days}${answers.flexible_days ? ' ±1' : ''}`
                      : (answers.days as string) || '4'}
                  </b>
                </div>
                <div>за рулём/день<b>{answers.drive || "до 4 ч"}</b></div>
                <div>крюк<b>{detourSummary}</b></div>
                <div>темп<b>{answers.pace || "спокойный"}</b></div>
              </div>

              {/* Message Stream Scrollable Box */}
              <div className="stream flex-1 overflow-y-auto" ref={streamRef} id="stream">

                {/* Phase: QUIZ */}
                {phase === 'quiz' && (
                  <div className="quiz">
                    {/* "Продолжить поездку" — only at the very landing step, and only
                        until the user explicitly acts (continue, or dismiss/×). Never
                        auto-restores: a fresh quiz must never be silently replaced by
                        an old draft, the user decides which one they want. */}
                    {step === 0 && resumableTrip && !resumeBannerDismissed && (
                      <div className="px-3 py-3 rounded bg-[#2c3138] border border-[#e8b53f]/40">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[10px] uppercase tracking-wide text-[#e8b53f] font-mono mb-1">
                              Есть незавершённая поездка
                            </div>
                            <div className="text-[13px] text-[#f2ede3] font-medium truncate">
                              {resumableTrip.origin_name && resumableTrip.destination_name
                                ? `${resumableTrip.origin_name} → ${resumableTrip.destination_name}`
                                : resumableTrip.title || 'Черновик поездки'}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setResumeBannerDismissed(true)}
                            className="text-[#8b9199] hover:text-[#f2ede3] text-sm leading-none cursor-pointer flex-shrink-0"
                            aria-label="Скрыть"
                          >
                            ×
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRestoreDraft(resumableTrip)}
                          className="btn btn-y mt-2.5 w-full"
                        >
                          Продолжить поездку
                        </button>
                      </div>
                    )}

                    <div className="q-prog">
                      ШАГ {step + 1} ИЗ {QUIZ.length}
                      <i>
                        <span style={{ width: `${(step / QUIZ.length) * 100}%` }} />
                      </i>
                    </div>
                    <div className="q-text">{currentQuestion.q}</div>

                    <div id="q-body">
                      {currentQuestion.type === 'text' && (
                        <>
                          <input
                            className="q-in"
                            id="q-val"
                            placeholder={currentQuestion.ph}
                            value={(answers[currentQuestion.k] as string) || ''}
                            onChange={(e) => handleTextAnswerChange(e.target.value)}
                            onBlur={(e) => {
                              if (currentQuestion.k === 'origin' || currentQuestion.k === 'dest') {
                                const val = e.target.value.trim();
                                if (val !== '') {
                                  resolveFieldCoords(currentQuestion.k as 'origin' | 'dest', val);
                                }
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && isCurrentStepValid() && !quizNextLoading) {
                                handleNextQuiz();
                              }
                            }}
                            autoFocus
                          />
                          {currentFieldGeoError && (
                            <div className="q-geo-error" style={{ color: '#c05640', fontSize: '12px', marginTop: '6px' }}>
                              {currentFieldGeoError}
                            </div>
                          )}
                          {(currentQuestion.k === 'origin' || currentQuestion.k === 'dest') && (
                            <button
                              type="button"
                              onClick={() => {
                                const field = currentQuestion.k as 'origin' | 'dest';
                                setPickingField(prev => (prev === field ? null : field));
                              }}
                              className={`opt mt-2 self-start ${pickingField === currentQuestion.k ? 'on' : ''}`}
                            >
                              {pickingField === currentQuestion.k ? 'Отменить выбор на карте (Esc)' : 'Указать на карте'}
                            </button>
                          )}
                        </>
                      )}

                      {(currentQuestion.type === 'one' || currentQuestion.type === 'many') && (
                        <div className="opts">
                          {currentQuestion.opts?.map((opt) => {
                            const ansVal = answers[currentQuestion.k];
                            const isSelected = currentQuestion.type === 'one'
                              ? ansVal === opt
                              : Array.isArray(ansVal) && ansVal.includes(opt);

                            return (
                              <button
                                key={opt}
                                className={`opt ${isSelected ? 'on' : ''}`}
                                onClick={() => handleSelectOption(opt)}
                              >
                                {opt}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {currentQuestion.type === 'days' && (
                        <div className="flex flex-col gap-4">
                          <div className="flex items-center gap-3">
                            <button
                              type="button"
                              className="btn btn-g"
                              onClick={() => handleDaysStep(-1)}
                              disabled={daysValue() <= DAYS_MIN}
                              aria-label="Меньше дней"
                            >
                              −
                            </button>
                            <span className="text-[28px] font-bold text-[#f2ede3] font-mono w-10 text-center">
                              {daysValue()}
                            </span>
                            <button
                              type="button"
                              className="btn btn-g"
                              onClick={() => handleDaysStep(1)}
                              disabled={daysValue() >= DAYS_MAX}
                              aria-label="Больше дней"
                            >
                              +
                            </button>
                            <span className="text-[13px] text-[#8b9199]">дней</span>
                          </div>
                          <label className="flex items-center gap-2 text-[13px] text-[#c9cfd6] cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={!!answers.flexible_days}
                              onChange={(e) => handleFlexibleDaysToggle(e.target.checked)}
                              className="accent-[#e8b53f] cursor-pointer"
                            />
                            ±1 день гибкости
                          </label>
                        </div>
                      )}
                    </div>

                    <div className="q-nav">
                      <button
                        className="btn btn-g"
                        onClick={handlePrevQuiz}
                        disabled={step === 0}
                      >
                        Назад
                      </button>
                      <button
                        className="btn btn-y"
                        id="q-next"
                        onClick={handleNextQuiz}
                        disabled={!isCurrentStepValid() || quizNextLoading}
                      >
                        {quizNextLoading ? 'Проверяем…' : 'Далее'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Chat message threads (Refine, Generating, Plan) — not shown for
                    finalizing/finalized, which have their own dedicated content
                    below instead of a message log (and, reached directly from
                    "Мои поездки", `messages` may hold stale text from a
                    different trip anyway). */}
                {phase !== 'quiz' && !['finalizing', 'finalized'].includes(phase) && messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`msg ${msg.sender}`}
                  >
                    {msg.text}
                  </div>
                ))}

                {/* Refine Action Building Button — free, anonymous, no auth
                    wall. The old "sign in to build" modal was removed here on
                    purpose: the draft (Valhalla options + stops) is free
                    value, and gating it behind auth was a wall before any
                    value was shown. Only Finalize needs auth. */}
                {phase === 'refine' && (
                  <button
                    className="btn btn-y mt-2 self-start"
                    onClick={() => startGeneration()}
                  >
                    Построить маршрут
                  </button>
                )}

                {/* Phase: GENERATING Progress bar and stepper */}
                {phase === 'generating' && (
                  <GenerationProgress currentStep={generationStep} />
                )}

                {/* Phase: FINALIZING — real progress, not a bare spinner (Фаза 3,
                    подшаг 3). The map alongside keeps showing the plan overlay
                    (see MapComponent's phase handling) so nothing goes blank. */}
                {phase === 'finalizing' && <FinalizeProgress />}

                {/* Phase: FINALIZED — the left panel just orients the user;
                    the actual result (times, days, stop cards, sources) is
                    FinalizedView on the right. */}
                {phase === 'finalized' && (
                  <div className="px-1 py-2">
                    <p className="text-[13px] text-[#c9cfd6] leading-relaxed">
                      Поездка финализирована: точное время маршрута, разбивка по дням и AI-гид —
                      в панели справа. Эта версия больше не меняется; черновик остаётся доступен отдельно.
                    </p>
                  </div>
                )}

              </div>

              {/* Compose Chat Input Form — reserved for text-based route edits, not
                  implemented yet. Disabled rather than hidden: the space and width
                  stay put so nothing in the layout shifts once this is wired up. */}
              <div className={`px-5 pb-1 ${!['refine', 'plan'].includes(phase) ? 'hidden' : ''}`}>
                <p className="text-[10px] text-[#5a5f66]">Уточнения в разработке</p>
              </div>
              <form
                className={`compose ${!['refine', 'plan'].includes(phase) ? 'hidden' : ''}`}
                id="compose"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendText(inputText);
                }}
              >
                <input
                  id="inp"
                  placeholder="Скоро: правки маршрута текстом"
                  aria-label="Сообщение"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  disabled
                />
                <button type="submit" className="btn btn-y" disabled>
                  Отправить
                </button>
              </form>
            </>

        </div>

        {/* RIGHT VIEWPORT: Google Map component + plan panel */}
        <main className="flex-1 h-[42vh] md:h-full flex overflow-hidden" id="right-viewport">
          <div className="relative flex-1 h-full overflow-hidden">
            <MapComponent
              phase={phase}
              generationStep={generationStep}
              routeLine={routeLine}
              originCoord={originCoord}
              destCoord={destCoord}
              onOriginDragEnd={(lat, lng) => handleMarkerDragEnd('origin', lat, lng)}
              onDestDragEnd={(lat, lng) => handleMarkerDragEnd('dest', lat, lng)}
              pickingField={pickingField}
              onMapClick={handleMapClick}
              planRouteLines={planRouteLinesForMap}
              planMarkers={planMarkersForMap}
              activeDaySegments={activeDaySegments}
              dayBoundaryMarkers={dayBoundaryMarkersForMap}
              lodgingMarkers={lodgingMarkersForMap}
              selectedStopId={selectedStopId}
              onSelectStop={handleSelectStop}
              onClosePopup={() => setSelectedStopId(null)}
              onToggleStop={handleToggleStop}
            />
          </div>

          {phase === 'plan' && (
            <PlanPanel
              options={options}
              activeOptionIndex={activeOptionIndex}
              onSelectTab={setActiveOptionIndex}
              includedByOption={includedByOption}
              onToggleStop={handleToggleStop}
              routeThroughByOption={routeThroughByOption}
              isRecomputing={loadingOptionIndex === activeOptionIndex}
              selectedStopId={selectedStopId}
              onSelectStop={handleSelectStop}
              detailedByOption={detailedByOption}
              enrichedByOption={enrichedByOption}
              onFinalizeClick={handleFinalizeClick}
              finalizePreviewLoading={finalizePreviewLoading}
            />
          )}

          {phase === 'finalized' && finalizedTrip && (
            <FinalizedView
              trip={finalizedTrip}
              selectedStopId={selectedStopId}
              onSelectStop={handleSelectStop}
              onEditDraft={handleEditDraftFromFinalized}
            />
          )}
        </main>

        {/* Confirm New Trip Modal */}
        <div className={`modal ${showConfirmNewTrip ? 'on' : ''}`} id="confirm-new-trip">
          <div className="modal-box">
            <h2>Начать новую поездку?</h2>
            <p>
              Текущий черновик сохранён, но списка поездок пока нет — после начала новой поездки вернуться к этой уже не получится. Начать заново?
            </p>
            <div className="flex gap-3 justify-end mt-4">
              <button
                className="px-4 py-2 text-xs font-semibold rounded bg-[#3a4048] text-white hover:bg-opacity-80"
                onClick={() => setShowConfirmNewTrip(false)}
              >
                Отмена
              </button>
              <button
                className="px-4 py-2 text-xs font-semibold rounded bg-[#c05640] text-white hover:bg-opacity-80"
                onClick={() => {
                  setShowConfirmNewTrip(false);
                  resetAllToNewQuiz();
                }}
              >
                Сбросить и начать заново
              </button>
            </div>
          </div>
        </div>

        <DateModal
          isOpen={showDateModal}
          onCancel={() => setShowDateModal(false)}
          onConfirm={handleConfirmEnrich}
        />

        {/* Sign-in modal — shared by PlanPanel's "Финализировать поездку" and
            the header's "Войти". Closing just hides the overlay; the draft
            underneath is untouched either way. */}
        <div className={`modal ${showFinalizeModal ? 'on' : ''}`} id="finalize-modal">
          <div className="modal-box">
            <h2>Сохраните и финализируйте поездку</h2>
            <p>
              Войдите, чтобы сохранить черновик и получить финальный маршрут. Ваши изменения уже сохранены.
            </p>
            <GoogleSignInButton onCredential={handleGoogleCredential} />
            {authModalError && (
              <p className="text-[11px] text-[#c05640] text-center mt-2">{authModalError}</p>
            )}
            <button
              className="auth-btn alt mt-2"
              onClick={() => {
                setShowFinalizeModal(false);
                setPendingAuthAction(null);
              }}
            >
              Закрыть
            </button>
          </div>
        </div>

        <MyTripsModal
          isOpen={showMyTripsModal}
          trips={myTrips}
          isLoading={isMyTripsLoading}
          onClose={() => setShowMyTripsModal(false)}
          onOpenTrip={handleOpenTripFromList}
          onDeleteTrip={handleDeleteTripFromList}
        />

        {/* Between the free preview and the paywall/confirm step — only
            shown when finalizePreview.needs_selection is true (see
            startFinalizePreview); otherwise skipped entirely. */}
        <LodgingSelectionModal
          isOpen={showLodgingModal}
          days={finalizePreview?.days ?? []}
          onContinue={handleLodgingContinue}
          onSkip={handleLodgingSkip}
          onCancel={handleLodgingCancel}
        />

        {/* Steps 2-3 of Finalize: paywall (balance=0) or the summary+confirm
            screen (balance>=1) — see openFinalizeGate/handleConfirmFinalize. */}
        <FinalizeGateModal
          isOpen={finalizeGateStage !== null}
          stage={finalizeGateStage}
          originName={String(originVal || 'Денвер')}
          destName={String(destVal || 'Дуранго')}
          stopCount={(includedByOption.get(activeOptionIndex) ?? new Set<number>()).size}
          plannedDays={typeof answers.days === 'number' ? answers.days : null}
          flexibleDays={!!answers.flexible_days}
          isFirstFinalize={!!credits?.is_first_finalize}
          submitting={finalizeSubmitting}
          error={finalizeGateError}
          onConfirm={handleConfirmFinalize}
          onClose={handleCloseFinalizeGate}
        />

        {/* Step 9: shown once, right after this user's first-ever finalized
            result — is_first_finalize comes off the finalize response itself
            (see loadFinalizedResult), price is never mentioned earlier than this. */}
        <WelcomeModal
          isOpen={showWelcomeModal}
          onClose={() => setShowWelcomeModal(false)}
        />

      </div>
    </div>
  );
}
