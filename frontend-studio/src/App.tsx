import React, { useState, useEffect, useRef } from 'react';
import { QuizQuestion, Day, ChatMessage, Stop, SavedTrip } from './types';
import { QUIZ, DAYS, COORDS, OVERNIGHTS, LINE } from './data';
import { MapComponent } from './components/MapComponent';
import { GenerationProgress } from './components/GenerationProgress';
import { Header } from './components/Header';
import { listTrips, getTrip, saveTrip, deleteTrip, archiveTrip } from './storage';
import { TripsList } from './components/TripsList';
import { buildGoogleMapsUrl, buildAppleMapsUrl, getExportDayData } from './export';
import { fetchRoute, decodeShape, geocode, reverseGeocode } from './api';

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

export default function App() {
  // Application Phase
  const [phase, setPhase] = useState<'quiz' | 'refine' | 'gen' | 'ready'>('quiz');

  // Quiz State
  const [step, setStep] = useState<number>(0);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});

  // Storage and Header State
  const [currentTripId, setCurrentTripId] = useState<string | null>(null);
  const [currentTripCreatedAt, setCurrentTripCreatedAt] = useState<string | null>(null);
  const [tripTitle, setTripTitle] = useState<string>('Новая поездка');
  const [isTitleManuallyEdited, setIsTitleManuallyEdited] = useState<boolean>(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>('saved');
  const [hasChanges, setHasChanges] = useState<boolean>(false);
  const [showTripsList, setShowTripsList] = useState<boolean>(false);
  const [savedTripsList, setSavedTripsList] = useState<SavedTrip[]>([]);
  const [deletingTripId, setDeletingTripId] = useState<string | null>(null);
  const [showConfirmNewTrip, setShowConfirmNewTrip] = useState<boolean>(false);

  // Ref to track if state changes are due to a trip loading / initializing
  const isInternalUpdate = useRef<boolean>(false);

  // Sequence counters guarding against out-of-order geocode/reverse-geocode responses
  // (e.g. a slow forward-geocode resolving after a later drag already set a better coordinate)
  const originRequestSeq = useRef<number>(0);
  const destRequestSeq = useRef<number>(0);

  // Chat State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState<string>('');

  // Itinerary State
  const [days, setDays] = useState<Day[]>(JSON.parse(JSON.stringify(DAYS)));
  const [removedIndices, setRemovedIndices] = useState<number[]>([]);
  const [routeLine, setRouteLine] = useState<{ lat: number; lng: number }[]>(LINE);
  const [originCoord, setOriginCoord] = useState<{ lat: number; lng: number } | null>(null);
  const [destCoord, setDestCoord] = useState<{ lat: number; lng: number } | null>(null);
  const [originGeo, setOriginGeo] = useState<FieldGeocodeState>(EMPTY_GEO_STATE);
  const [destGeo, setDestGeo] = useState<FieldGeocodeState>(EMPTY_GEO_STATE);
  const [quizNextLoading, setQuizNextLoading] = useState<boolean>(false);
  // Which field a "pick on the map" click will set, or null when not in picking mode
  const [pickingField, setPickingField] = useState<'origin' | 'dest' | null>(null);
  const [activeStopIndex, setActiveStopIndex] = useState<number | null>(null);
  const [expandedDays, setExpandedDays] = useState<number[]>([1]); // Day 1 open by default

  // Generation Timer State
  const [generationStep, setGenerationStep] = useState<number>(0);

  // Summary Modifiers
  const [detourSummary, setDetourSummary] = useState<string>('');

  // Auth Modal State
  const [showModal, setShowModal] = useState<boolean>(false);

  // Refs for scrolling and auto-scroll chat
  const streamRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Auto-scroll stream when messages or stop selection change
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [messages, phase, step]);

  // Scroll details card into view when active stop changes
  useEffect(() => {
    if (activeStopIndex !== null && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeStopIndex]);

  // Load saved trips on mount
  useEffect(() => {
    setSavedTripsList(listTrips());
  }, []);

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

  // Auto-save effect: every 30 seconds if there are unsaved changes
  useEffect(() => {
    if (!hasChanges || phase === 'quiz') return;

    const timer = setInterval(() => {
      handleSave();
    }, 30000);

    return () => clearInterval(timer);
  }, [hasChanges, phase, answers, days, removedIndices, tripTitle, currentTripId, currentTripCreatedAt, isTitleManuallyEdited]);

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

  // Helper for short uppercase labels
  const short = (s: string | string[] | undefined) => {
    if (!s) return '';
    const text = Array.isArray(s) ? s.join(', ') : s;
    return text.slice(0, 3).toUpperCase();
  };

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

      if (phase === 'ready') {
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
      const text = typeof rawVal === 'string' && rawVal.trim() !== '' ? rawVal : currentQuestion.def || '';
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

  // Save Trip action
  const handleSave = () => {
    setSaveState('saving');
    setTimeout(() => {
      try {
        const originVal = answers.origin ? (Array.isArray(answers.origin) ? answers.origin[0] : answers.origin) : 'Денвер';
        const destVal = answers.dest ? (Array.isArray(answers.dest) ? answers.dest[0] : answers.dest) : 'Лас-Вегас';
        const title = tripTitle || `${originVal} → ${destVal}`;

        const tripToSave: SavedTrip = {
          id: currentTripId || `trip_${Date.now()}`,
          title,
          origin: originVal,
          dest: destVal,
          status: phase === 'ready' ? 'ready' : 'draft',
          answers,
          plan: phase === 'ready' ? { days, version: 1, removedIndices } : null,
          createdAt: currentTripCreatedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        const saved = saveTrip(tripToSave);
        
        isInternalUpdate.current = true;
        setCurrentTripId(saved.id);
        setCurrentTripCreatedAt(saved.createdAt);
        setHasChanges(false);
        setSaveState('saved');
        
        setSavedTripsList(listTrips());
      } catch (e) {
        console.error(e);
        setSaveState('unsaved');
      }
    }, 300);
  };

  // Load selected trip from directory
  const handleLoadTrip = (trip: SavedTrip) => {
    isInternalUpdate.current = true;
    setPickingField(null); // don't carry map-picking mode over into the loaded trip
    setCurrentTripId(trip.id);
    setCurrentTripCreatedAt(trip.createdAt);
    setTripTitle(trip.title);
    setIsTitleManuallyEdited(true);
    setAnswers(trip.answers);
    setRouteLine(LINE);
    setOriginCoord(null);
    setDestCoord(null);
    setOriginGeo(EMPTY_GEO_STATE);
    setDestGeo(EMPTY_GEO_STATE);
    // Invalidate any in-flight geocode/drag requests from before this trip was loaded
    originRequestSeq.current += 1;
    destRequestSeq.current += 1;

    if (trip.plan) {
      setDays(trip.plan.days);
      setRemovedIndices(trip.plan.removedIndices || []);
      setPhase('ready');
      
      const totalStopsCount = trip.plan.days.reduce((acc, d) => acc + d.stops.length, 0);
      setMessages([
        { id: `ready-bot-init`, sender: 'bot', text: `Маршрут готов: ${trip.plan.days.length} дней, ${totalStopsCount} остановок. Ни один день не превышает ваш лимит.` }
      ]);
    } else {
      setPhase('refine');
      setDays(JSON.parse(JSON.stringify(DAYS)));
      setRemovedIndices([]);
      
      const interestsStr = (trip.answers.interests as string[] || ['каньоны']).join(', ');
      const userPromptText = `Я хочу спланировать поездку из ${trip.answers.origin || 'Денвер'} в ${trip.answers.dest || 'Лас-Вегас'} на ${trip.answers.days || '5–6'} дней. Люблю ${interestsStr}.`;
      const botWelcomeText = 'Так я понял вашу поездку. Можно уточнить в чате. Когда готовы, нажмите «Построить маршрут».';
      setMessages([
        { id: 'refine-user-init', sender: 'user', text: userPromptText },
        { id: 'refine-bot-init', sender: 'bot', text: botWelcomeText }
      ]);

      const originText = Array.isArray(trip.answers.origin) ? trip.answers.origin[0] : trip.answers.origin;
      const destText = Array.isArray(trip.answers.dest) ? trip.answers.dest[0] : trip.answers.dest;
      Promise.all([
        resolveFieldCoords('origin', originText || 'Денвер'),
        resolveFieldCoords('dest', destText || 'Дуранго')
      ]).then(([originOk, destOk]) => {
        if (!originOk || !destOk) {
          setMessages(prev => [...prev, {
            id: `geocode-error-${Date.now()}`,
            sender: 'bot',
            text: 'Не удалось определить координаты отправления или назначения. Построение маршрута может использовать точки по умолчанию.'
          }]);
        }
      });
    }

    setActiveStopIndex(null);
    setExpandedDays([1]);
    setHasChanges(false);
    setSaveState('saved');
    setShowTripsList(false);
  };

  // Archive trip action
  const handleArchiveTrip = (id: string) => {
    archiveTrip(id);
    setSavedTripsList(listTrips());
    if (currentTripId === id) {
      const updated = getTrip(id);
      if (updated) {
        isInternalUpdate.current = true;
        setPhase(updated.status === 'ready' ? 'ready' : 'refine');
      }
    }
  };

  // Delete trip action
  const handleDeleteTripAction = (id: string) => {
    deleteTrip(id);
    setSavedTripsList(listTrips());
    if (currentTripId === id) {
      // Current trip was deleted, trigger standard reset
      resetAllToNewQuiz();
    }
  };

  // Reset function to start new trip
  const resetAllToNewQuiz = () => {
    isInternalUpdate.current = true;
    setPhase('quiz');
    setStep(0);
    setAnswers({});
    setMessages([]);
    setInputText('');
    setDays(JSON.parse(JSON.stringify(DAYS)));
    setRemovedIndices([]);
    setRouteLine(LINE);
    setOriginCoord(null);
    setDestCoord(null);
    setOriginGeo(EMPTY_GEO_STATE);
    setDestGeo(EMPTY_GEO_STATE);
    // Invalidate any in-flight geocode/drag requests from the trip being reset
    originRequestSeq.current += 1;
    destRequestSeq.current += 1;
    setActiveStopIndex(null);
    setExpandedDays([1]);
    setGenerationStep(0);
    setDetourSummary('');
    setCurrentTripId(null);
    setCurrentTripCreatedAt(null);
    setTripTitle('Новая поездка');
    setIsTitleManuallyEdited(false);
    setHasChanges(false);
    setSaveState('saved');
    setShowTripsList(false);
  };

  // Confirm and start a new trip
  const handleNewTripClick = () => {
    if (hasChanges) {
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

    // Save draft trip to localStorage right after quiz completion
    try {
      const originVal = currentAnswers.origin ? (Array.isArray(currentAnswers.origin) ? currentAnswers.origin[0] : currentAnswers.origin) : 'Денвер';
      const destVal = currentAnswers.dest ? (Array.isArray(currentAnswers.dest) ? currentAnswers.dest[0] : currentAnswers.dest) : 'Лас-Вегас';
      const title = `${originVal} → ${destVal}`;

      const draftId = `trip_${Date.now()}`;
      const draftTrip: SavedTrip = {
        id: draftId,
        title,
        origin: originVal,
        dest: destVal,
        status: 'draft',
        answers: currentAnswers,
        plan: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const saved = saveTrip(draftTrip);
      
      setCurrentTripId(saved.id);
      setCurrentTripCreatedAt(saved.createdAt);
      setTripTitle(saved.title);
      setHasChanges(false);
      setSaveState('saved');
      setSavedTripsList(listTrips());
    } catch (e) {
      console.error('Error saving draft trip after quiz:', e);
    }
  };

  // Modal / Auth actions
  const handleBuildRouteClick = () => {
    setShowModal(true);
  };

  const handleAuthConfirm = () => {
    setShowModal(false);
    startGeneration();
  };

  // Start Generation Phase. Accepts coordinate overrides so a marker drag can trigger a
  // rebuild with its just-resolved coordinate without waiting for a re-render to land in
  // originCoord/destCoord state (which this closure would otherwise read stale).
  const startGeneration = (
    originOverride?: { lat: number; lng: number } | null,
    destOverride?: { lat: number; lng: number } | null
  ) => {
    setPhase('gen');
    setGenerationStep(0);

    const botGeneratingText = 'Строю маршрут. Каждая точка проверяется по реальной дорожной сети.';
    setMessages(prev => [...prev, { id: `gen-bot-${Date.now()}`, sender: 'bot', text: botGeneratingText }]);

    // Fetch the real route geometry from the backend; fall back to the static LINE on failure
    const origin = originOverride ?? originCoord ?? TRIP_ORIGIN;
    const dest = destOverride ?? destCoord ?? TRIP_DEST;
    fetchRoute(origin.lat, origin.lng, dest.lat, dest.lng)
      .then(result => {
        setRouteLine(decodeShape(result.shape));
      })
      .catch(err => {
        console.error('Failed to fetch route, falling back to static line:', err);
        setRouteLine(LINE);
      });

    // Sequential timing simulation matching the HTML prototype
    let currentStep = 0;
    const interval = setInterval(() => {
      currentStep += 1;
      if (currentStep <= 5) {
        setGenerationStep(currentStep);
      } else {
        clearInterval(interval);
        setTimeout(() => {
          startReady();
        }, 600);
      }
    }, 550);
  };

  // Ready Phase
  const startReady = () => {
    setPhase('ready');

    const totalStopsCount = DAYS.reduce((acc, d) => acc + d.stops.length, 0);
    const botReadyText = `Маршрут готов: ${DAYS.length} дней, ${totalStopsCount} остановок. Ни один день не превышает ваш лимит. Откройте точку, чтобы увидеть, почему она здесь.`;

    setMessages([
      { id: `ready-bot-init`, sender: 'bot', text: botReadyText }
    ]);

    // Save trip with status "ready" and plan
    try {
      const originVal = answers.origin ? (Array.isArray(answers.origin) ? answers.origin[0] : answers.origin) : 'Денвер';
      const destVal = answers.dest ? (Array.isArray(answers.dest) ? answers.dest[0] : answers.dest) : 'Лас-Вегас';
      const title = isTitleManuallyEdited ? tripTitle : `${originVal} → ${destVal}`;

      const readyTrip: SavedTrip = {
        id: currentTripId || `trip_${Date.now()}`,
        title,
        origin: originVal,
        dest: destVal,
        status: 'ready',
        answers,
        plan: { days, version: 1, removedIndices },
        createdAt: currentTripCreatedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const saved = saveTrip(readyTrip);
      
      setCurrentTripId(saved.id);
      setCurrentTripCreatedAt(saved.createdAt);
      setHasChanges(false);
      setSaveState('saved');
      setSavedTripsList(listTrips());
    } catch (e) {
      console.error('Error saving ready trip:', e);
    }
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
    let botReplyText = 'Понял. Пересчитываю затронутый день…';

    if (phase === 'refine') {
      setHasChanges(true);
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
    } else if (phase === 'ready') {
      setHasChanges(true);
      setSaveState('unsaved');
      if (text.includes('музей')) {
        const museumStopIndex = 3; // "Музей Юты"
        if (!removedIndices.includes(museumStopIndex)) {
          removeStop(museumStopIndex);
          botReplyText = 'Убрал музей из второго дня. Освободилось 1 ч 15 — день стал свободнее.';
        } else {
          botReplyText = 'Музея во втором дне уже нет.';
        }
      } else if (text.includes('плотн')) {
        // Toggle Day 2 (index 1) dense mode
        setDays(prev => prev.map((d, i) => i === 1 ? { ...d, dense: true } : d));
        botReplyText = 'Второй день: 3:55 за рулём плюс 3 ч на остановки. Это близко к пределу. Могу убрать одну точку или перенести ночёвку ближе — что предпочитаете?';
      } else if (text.includes('крюк') || text.includes('45')) {
        setDetourSummary('до 45 мин');
        botReplyText = 'Поднял лимит крюка до 45 минут. Появились новые кандидаты — Dead Horse Point и Kodachrome Basin. Добавить?';
      } else if (text.includes('ночёвк') || text.includes('ночевк')) {
        botReplyText = 'Перенёс ночёвку ближе к Zion — Спрингдейл вместо Кейнаба. Пятый день стал короче на 40 минут.';
      } else if (text.includes('удали') || text.includes('убери')) {
        botReplyText = 'Какую именно точку убрать? Нажмите на неё в списке или назовите.';
      }
    }

    setMessages(prev => [...prev, {
      id: `bot-reply-${Date.now()}`,
      sender: 'bot',
      text: botReplyText
    }]);
  };

  // Remove Stop Action
  const removeStop = (stopIdx: number) => {
    setRemovedIndices(prev => {
      if (prev.includes(stopIdx)) return prev;
      return [...prev, stopIdx];
    });

    if (activeStopIndex === stopIdx) {
      setActiveStopIndex(null);
    }

    setHasChanges(true);
    setSaveState('unsaved');

    // Append system message in chronological order
    setMessages(prev => [...prev, {
      id: `sys-remove-${Date.now()}`,
      sender: 'sys',
      text: 'Остановка удалена. День пересчитан.'
    }]);
  };

  // Toggle Day Accordion Expansion
  const toggleDayExpanded = (dayNum: number) => {
    setExpandedDays(prev =>
      prev.includes(dayNum)
        ? prev.filter(n => n !== dayNum)
        : [...prev, dayNum]
    );
  };

  // Select Stop Details
  const handleSelectStop = (stopIdx: number, dayNum: number) => {
    setActiveStopIndex(stopIdx);
    // Auto expand parent day
    if (!expandedDays.includes(dayNum)) {
      setExpandedDays(prev => [...prev, dayNum]);
    }
  };

  // Determine Stop Data by selected index
  let selectedStop: Stop | null = null;
  let selectedStopDay: Day | null = null;
  if (activeStopIndex !== null) {
    days.forEach(d => {
      d.stops.forEach(s => {
        if (s.i === activeStopIndex) {
          selectedStop = s;
          selectedStopDay = d;
        }
      });
    });
  }

  // Prebaked chat hints for different phases
  const getHints = () => {
    if (phase === 'refine') {
      return ["С нами ребёнок 8 лет", "Обязательно заехать в Моаб", "Хайки максимум 2 мили"];
    }
    if (phase === 'ready') {
      return ["Убери музей во втором дне", "Второй день слишком плотный", "Разреши крюк до 45 минут"];
    }
    return [];
  };

  // Origin & destination header labels
  const originVal = answers.origin ? (Array.isArray(answers.origin) ? answers.origin[0] : answers.origin) : '';
  const destVal = answers.dest ? (Array.isArray(answers.dest) ? answers.dest[0] : answers.dest) : '';

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#22262b]">
      <Header
        tripTitle={tripTitle}
        saveState={saveState}
        hasChanges={hasChanges}
        onSave={handleSave}
        onTitleChange={(newTitle) => {
          setTripTitle(newTitle);
          setIsTitleManuallyEdited(true);
          setHasChanges(true);
        }}
        onOpenTrips={() => {
          setShowTripsList(true);
          setSavedTripsList(listTrips());
        }}
        onNewTrip={handleNewTripClick}
      />

      <div className="app flex-1 min-h-0">
        {/* LEFT PANEL: Console Control Panel */}
        <div className="panel w-full md:w-[420px] md:min-w-[420px] h-[58vh] md:h-full bg-asphalt flex flex-col min-w-0 border-r border-[#000000]">
          
          {showTripsList ? (
            <TripsList
              trips={savedTripsList}
              onOpen={(id) => {
                const tr = savedTripsList.find((t) => t.id === id);
                if (tr) handleLoadTrip(tr);
              }}
              onArchive={(id) => {
                handleArchiveTrip(id);
              }}
              onDelete={(id) => {
                handleDeleteTripAction(id);
              }}
              onBack={() => setShowTripsList(false)}
              onNew={() => {
                setShowTripsList(false);
                handleNewTripClick();
              }}
            />
          ) : (
            <>
              {/* Header Head Section */}
              <div className="head">
                <h1 className="text-white">Текущий маршрут</h1>
                {phase !== 'quiz' && (
                  <span className="route" id="route-lbl">
                    {short(originVal)} → {short(destVal)}
                  </span>
                )}
              </div>

              {/* Dynamic Trip Summary Bar */}
              <div className={`summary ${['quiz', 'gen'].includes(phase) ? 'hidden' : ''}`} id="summary">
                <div>дней<b>{answers.days || "5–6"}</b></div>
                <div>за рулём/день<b>{answers.drive || "до 4 ч"}</b></div>
                <div>крюк<b>{detourSummary}</b></div>
                <div>темп<b>{answers.pace || "спокойный"}</b></div>
              </div>

              {/* Message Stream Scrollable Box */}
              <div className="stream flex-1 overflow-y-auto" ref={streamRef} id="stream">
                
                {/* Phase: QUIZ */}
                {phase === 'quiz' && (
                  <div className="quiz">
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

                {/* Chat message threads (Refine, Gen, Ready) */}
                {phase !== 'quiz' && messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`msg ${msg.sender}`}
                  >
                    {msg.text}
                  </div>
                ))}

                {/* Refine Action Building Button */}
                {phase === 'refine' && (
                  <button
                    className="btn btn-y mt-2 self-start"
                    onClick={handleBuildRouteClick}
                  >
                    Построить маршрут
                  </button>
                )}

                {/* Phase: GENERATING Progress bar and stepper */}
                {phase === 'gen' && (
                  <GenerationProgress currentStep={generationStep} />
                )}

                {/* Phase: READY Day Itinerary Cards list */}
                {phase === 'ready' && (
                  <div className="space-y-3.5 w-full mt-2">
                    {days.map((day) => {
                      const isExpanded = expandedDays.includes(day.n);
                      const visibleStops = day.stops.filter(s => !removedIndices.includes(s.i));

                      return (
                        <div
                          key={day.n}
                          className={`day ${isExpanded ? 'open' : ''} ${day.dense ? 'dense' : ''}`}
                        >
                          {/* Day Top Header Bar */}
                          <div
                            className="day-top"
                            onClick={() => toggleDayExpanded(day.n)}
                          >
                            <span className="day-n">Д{day.n}</span>
                            <span className="day-t">{day.t}</span>
                            <span className="day-m">{day.drive}</span>
                          </div>

                          {/* Collapsible Day Body List */}
                          {isExpanded && (
                            <div className="day-body">
                              {visibleStops.length > 0 ? (
                                visibleStops.map((stop) => {
                                  const isSelected = activeStopIndex === stop.i;
                                  return (
                                    <div
                                      key={stop.i}
                                      className={`stop ${isSelected ? 'sel' : ''}`}
                                      onClick={() => handleSelectStop(stop.i, day.n)}
                                    >
                                      <span className="pin">{stop.i + 1}</span>
                                      <span>
                                        <span className="stop-n block">{stop.n}</span>
                                        <span className="stop-c block">{stop.c}</span>
                                        
                                        <span className="detour">
                                          <span className={`bar ${stop.w > 65 ? 'warn' : ''}`}>
                                            <span style={{ width: `${stop.w}%` }} />
                                          </span>
                                          <em>+{stop.d} мин</em>
                                        </span>
                                      </span>
                                    </div>
                                  );
                                })
                              ) : (
                                <div style={{ padding: '9px', fontSize: '12px', color: '#6c727a' }}>
                                  Остановок нет
                                </div>
                              )}

                              {/* Map export buttons row */}
                              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[#e4dccd] justify-end px-2">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const exportDay = getExportDayData(day, removedIndices);
                                    const url = buildGoogleMapsUrl(exportDay);
                                    window.open(url, '_blank');
                                  }}
                                  className="bg-transparent border border-[#e4dccd] hover:border-[#c05640] text-[#3d434a] hover:text-[#c05640] transition-colors rounded px-2.5 py-1 text-[11px] font-medium cursor-pointer"
                                >
                                  Открыть в Google Maps
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const exportDay = getExportDayData(day, removedIndices);
                                    const url = buildAppleMapsUrl(exportDay);
                                    window.open(url, '_blank');
                                  }}
                                  className="bg-transparent border border-[#e4dccd] hover:border-[#c05640] text-[#3d434a] hover:text-[#c05640] transition-colors rounded px-2.5 py-1 text-[11px] font-medium cursor-pointer"
                                >
                                  Открыть в Apple Maps
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Selected Stop Details Card in Stream viewport */}
                {phase === 'ready' && selectedStop && selectedStopDay && (
                  <div className="card mt-4 scroll-mt-2" ref={cardRef} id="card">
                    <div className="cat">{(selectedStop as Stop).c}</div>
                    <h3>{(selectedStop as Stop).n}</h3>
                    
                    <div className="facts">
                      <div className="fact"><i>реальный крюк</i><b>+{(selectedStop as Stop).d} мин</b></div>
                      <div className="fact"><i>на посещение</i><b>{(selectedStop as Stop).vis}</b></div>
                      <div className="fact"><i>день</i><b>{(selectedStopDay as Day).n} из {days.length}</b></div>
                      <div className="fact"><i>за рулём в день</i><b>{(selectedStopDay as Day).drive}</b></div>
                    </div>

                    <p className="why">{(selectedStop as Stop).why}</p>
                    <span className="verify">Проверено · официальный источник</span>
                    
                    <div className="card-acts">
                      <button onClick={() => removeStop((selectedStop as Stop).i)}>Удалить</button>
                      <button onClick={() => handleSendText(`Замени ${(selectedStop as Stop).n} на что-то похожее`)}>Заменить</button>
                      <button onClick={() => handleSendText(`Сделай ${(selectedStop as Stop).n} необязательной`)}>Сделать optional</button>
                    </div>
                  </div>
                )}

              </div>

              {/* Hints Buttons List Bar */}
              <div className={`hints ${!['refine', 'ready'].includes(phase) ? 'hidden' : ''}`} id="hints">
                {getHints().map((hText) => (
                  <button
                    key={hText}
                    className="hint"
                    onClick={() => handleSendText(hText)}
                  >
                    {hText}
                  </button>
                ))}
              </div>

              {/* Compose Chat Input Form */}
              <form
                className={`compose ${!['refine', 'ready'].includes(phase) ? 'hidden' : ''}`}
                id="compose"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendText(inputText);
                }}
              >
                <input
                  id="inp"
                  placeholder="Уточните пожелания…"
                  aria-label="Сообщение"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                />
                <button type="submit" className="btn btn-y">
                  Отправить
                </button>
              </form>
            </>
          )}

        </div>

        {/* RIGHT VIEWPORT: Google Map component */}
        <main className="flex-1 h-[42vh] md:h-full relative overflow-hidden" id="right-viewport">
          <MapComponent
            activeStopIndex={activeStopIndex}
            onStopClick={(idx) => handleSelectStop(idx, Math.ceil((idx + 1) / 2))}
            removedIndices={removedIndices}
            phase={phase}
            generationStep={generationStep}
            routeLine={routeLine}
            originCoord={originCoord}
            destCoord={destCoord}
            onOriginDragEnd={(lat, lng) => handleMarkerDragEnd('origin', lat, lng)}
            onDestDragEnd={(lat, lng) => handleMarkerDragEnd('dest', lat, lng)}
            pickingField={pickingField}
            onMapClick={handleMapClick}
          />
        </main>

        {/* Auth Modal overlay block */}
        <div className={`modal ${showModal ? 'on' : ''}`} id="modal">
          <div className="modal-box">
            <h2>Войдите, чтобы построить маршрут</h2>
            <p>
              Расчёт использует внешние сервисы. Аккаунт нужен, чтобы сохранить поездку и вернуться к ней. Ответы квиза не потеряются.
            </p>
            <button className="auth-btn" onClick={handleAuthConfirm}>
              Продолжить с Google
            </button>
            <button className="auth-btn" onClick={handleAuthConfirm}>
              Продолжить с Apple
            </button>
            <button className="auth-btn alt" onClick={handleAuthConfirm}>
              Ссылка на email
            </button>
          </div>
        </div>

        {/* Confirm New Trip Modal */}
        <div className={`modal ${showConfirmNewTrip ? 'on' : ''}`} id="confirm-new-trip">
          <div className="modal-box">
            <h2>Начать новую поездку?</h2>
            <p>
              У вас есть несохранённые изменения в текущей поездке. Вы уверены, что хотите сбросить её и начать заново? Несохранённые изменения будут утеряны.
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

      </div>
    </div>
  );
}
