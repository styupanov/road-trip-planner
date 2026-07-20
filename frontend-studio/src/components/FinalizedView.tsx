import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Info, Calendar, CheckCircle2, BedDouble, ExternalLink, Navigation } from 'lucide-react';
import { DayPlan, FinalizedLodging, FinalizedStop, FinalizedTripResult } from '../api';
import { formatDuration, formatDaysRu } from '../format';
import { dayColor } from '../dayColors';
import { buildGoogleMapsDayUrl } from '../googleMapsExport';

export interface FinalizedViewProps {
  trip: FinalizedTripResult;
  selectedStopId: number | null;
  onSelectStop: (id: number) => void;
  onEditDraft: () => void;
  // Reverse highlight (map segment hover -> panel), optional per spec.
  onDayHover?: (day: number | null) => void;
}

// Imperative, not a prop, on purpose: expandedDays/activeDay are FinalizedView's
// OWN local state (per spec — not lifted to App.tsx, not in snapshot/draft_state),
// but a map segment click originates in a SIBLING component (MapComponent) that
// App.tsx also renders. A ref exposing "make this day visible" is the standard
// way to let a sibling's event reach into a component's local state without
// lifting that state up just to serve one cross-component interaction.
export interface FinalizedViewHandle {
  focusDay: (dayNumber: number) => void;
}

const FinalizedStopCard: React.FC<{
  stop: FinalizedStop;
  isSelected: boolean;
  order: number;
  onSelectStop: (id: number) => void;
}> = ({ stop, isSelected, order, onSelectStop }) => (
  <div
    onClick={() => onSelectStop(stop.id)}
    className={`w-full text-left p-2.5 rounded transition-colors cursor-pointer border flex gap-2.5 ${
      isSelected ? 'bg-[#2c3138] border-[#e8b53f]' : 'bg-[#1a1d21] border-transparent hover:bg-[#22262b]'
    }`}
  >
    <span className="mt-0.5 flex-shrink-0 w-[26px] h-[26px] rounded-full bg-[#e8b53f] text-[#14171a] text-[12px] font-bold flex items-center justify-center">
      {order}
    </span>
    <div className="min-w-0 flex-1">
      <div className="text-[11px] uppercase tracking-wide text-[#8b9199] font-mono truncate">
        {stop.category}
      </div>
      <div className="text-[17px] font-medium text-[#f2ede3] leading-tight mt-0.5 truncate">
        {stop.name}
      </div>
      <div className="text-[11px] font-mono text-[#8b9199] mt-1.5">
        {stop.rating != null ? `★ ${stop.rating.toFixed(1)}` : 'без рейтинга'}
        {stop.review_count != null ? ` · ${stop.review_count}` : ''}
      </div>

      {/* Enrichment is guaranteed here — a finalized snapshot never exists
          without it (Gemini failure fails the whole job, see finalize.py) —
          unlike PlanPanel's draft cards, no conditional wrapper needed. */}
      <div className="mt-2.5 pt-2.5 border-t-[0.5px] border-[#2c3138] space-y-2">
        <p className="text-[14px] text-[#f2ede3] leading-snug">{stop.why}</p>

        {stop.tips && (
          <div className="flex gap-1.5 items-start" onClick={(e) => e.stopPropagation()}>
            <Info size={13} className="text-[#8b9199] flex-shrink-0 mt-0.5" />
            <p className="text-[13px] text-[#c7cdd4] leading-snug">{stop.tips}</p>
          </div>
        )}

        {stop.dates_note && (
          <div
            className="px-2.5 py-2 rounded bg-[#e8b53f]/10 border border-[#e8b53f]/25"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-[#e8b53f] font-mono mb-1">
              <Calendar size={11} className="flex-shrink-0" />
              по данным поиска
            </div>
            <p className="text-[12px] text-[#c7cdd4] leading-snug">{stop.dates_note}</p>
          </div>
        )}
      </div>
    </div>
  </div>
);

const LodgingLine: React.FC<{ lodging: FinalizedLodging }> = ({ lodging }) => (
  <a
    href={lodging.maps_url}
    target="_blank"
    rel="noopener noreferrer"
    className="flex items-center gap-1.5 px-2.5 py-2 mt-1.5 rounded bg-[#16a085]/10 border border-[#16a085]/25 hover:bg-[#16a085]/15 transition-colors"
  >
    <BedDouble size={13} className="text-[#16a085] flex-shrink-0" />
    <span className="text-[12px] text-[#c7cdd4] leading-snug min-w-0 truncate">
      Ночёвка: <span className="text-[#f2ede3] font-medium">{lodging.name}</span>
      {lodging.vicinity && ` — ${lodging.vicinity}`}
      {lodging.rating != null && ` ★${lodging.rating.toFixed(1)}`}
    </span>
    <ExternalLink size={11} className="text-[#6a9fd8] flex-shrink-0 ml-auto" />
  </a>
);

// day_plan is derived server-side from the FINISHED snapshot.days, not from
// get_route_detail's own fits_plan (which only ever existed in the no-lodging
// path and never made it into the snapshot) — see finalize.py. This just
// renders it: neutral by default, warning-accent (same style as a day's own
// over_limit badge) only when over_plan is true, which the backend already
// guarantees is false whenever flexible is true — no flexible-check needed
// here, over_plan alone is the single source of truth for the accent.
const DayPlanLine: React.FC<{ dayPlan: DayPlan }> = ({ dayPlan }) => {
  const { requested, actual, over_plan } = dayPlan;
  const overBy = requested != null ? actual - requested : 0;

  return (
    <div
      className={`flex items-start gap-1.5 text-[11px] mt-1.5 ${
        over_plan ? 'text-[#c05640]' : 'text-[#8b9199]'
      }`}
    >
      {over_plan && <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />}
      <span className="leading-snug">
        Поездка займёт {formatDaysRu(actual)}
        {requested != null && requested !== actual && ` — вы планировали ${formatDaysRu(requested)}`}
        {over_plan && <span className="font-semibold"> (на {formatDaysRu(overBy)} больше плана)</span>}
      </span>
    </div>
  );
};

const formatFinalizedAt = (iso: string): string => {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

// Read-only counterpart to PlanPanel — renders a finalized trip_versions
// snapshot exactly as it was locked in, no checkboxes, no option tabs (a
// finalized trip has exactly one route, not several alternatives to compare).
export const FinalizedView = forwardRef<FinalizedViewHandle, FinalizedViewProps>(({
  trip, selectedStopId, onSelectStop, onEditDraft, onDayHover,
}, ref) => {
  const orderById = new Map(trip.stops.map((s, i) => [s.id, i + 1]));

  // Multi-accordion: any number of days can be expanded at once, toggling
  // one never affects the others. Day 1 open by default, everything else
  // collapsed — matches how a finalized trip is actually read (start with
  // tomorrow's plan, open the rest as needed).
  const [expandedDays, setExpandedDays] = useState<Set<number>>(() => new Set([1]));
  // "Last day clicked on the map" — an accent, not a second expand/collapse
  // flag (see FinalizedViewHandle's own comment on why this is imperative).
  const [activeDay, setActiveDay] = useState<number | null>(null);
  const dayHeaderRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const toggleDay = (dayNumber: number) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(dayNumber)) next.delete(dayNumber);
      else next.add(dayNumber);
      return next;
    });
  };

  useImperativeHandle(ref, () => ({
    focusDay: (dayNumber: number) => {
      setExpandedDays((prev) => (prev.has(dayNumber) ? prev : new Set(prev).add(dayNumber)));
      setActiveDay(dayNumber);
      dayHeaderRefs.current.get(dayNumber)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  }));

  return (
    <aside className="w-[min(560px,40vw)] h-full flex flex-col bg-[#14171a] border-l border-black overflow-hidden">
      <div className="px-4 py-3 border-b border-black flex-shrink-0">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[#5a9e6f] font-mono mb-1.5">
          <CheckCircle2 size={12} className="flex-shrink-0" />
          Финализировано {formatFinalizedAt(trip.finalized_at)}
        </div>
        <div className="text-[11px] font-mono text-[#8b9199]">
          {formatDuration(trip.route.duration_s)} · {Math.round(trip.route.distance_km)} км{' '}
          {/* Never "(оценка)" here — this is Google's exact number, locked in. */}
          <span className="text-[10px]">(Google)</span>
        </div>
        <div className="text-[11px] font-mono text-[#8b9199] mt-1.5">
          {trip.stops.length} остановок · {formatDaysRu(trip.days.length)}
          {trip.trip_dates ? ` · ${trip.trip_dates}` : ''}
        </div>
        <DayPlanLine dayPlan={trip.day_plan} />
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
        {trip.enrichment.overview && (
          <div className="mb-1">
            <p className="text-[11px] text-[#c7cdd4] leading-snug">{trip.enrichment.overview}</p>
            {trip.enrichment.warnings.length > 0 && (
              <div className="mt-2 space-y-1">
                {trip.enrichment.warnings.map((w, i) => (
                  <div key={i} className="flex gap-1.5 px-2 py-1.5 rounded bg-[#2a1f1a] border-l-2 border-[#c05640]">
                    <span className="text-[#c05640] text-[11px] flex-shrink-0">⚠</span>
                    <p className="text-[11px] text-[#d8a898] leading-snug">{w}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {trip.days.map((day, dayIdx) => {
          const dayStops = day.stop_indices
            .map((idx) => trip.stops[idx])
            .filter((s): s is FinalizedStop => s != null);
          const prevDayLodging = dayIdx > 0 ? trip.days[dayIdx - 1].lodging : null;
          const mapsUrl = buildGoogleMapsDayUrl(
            day, dayStops, prevDayLodging, { lat: trip.origin.lat, lon: trip.origin.lon }
          );
          const isExpanded = expandedDays.has(day.day);
          const isActive = activeDay === day.day;

          return (
            <div
              key={day.day}
              className={`rounded transition-colors ${isActive ? 'bg-[#e8b53f]/5 ring-1 ring-[#e8b53f]/40' : ''}`}
              onMouseEnter={() => onDayHover?.(day.day)}
              onMouseLeave={() => onDayHover?.(null)}
            >
              <button
                type="button"
                ref={(el) => {
                  if (el) dayHeaderRefs.current.set(day.day, el);
                  else dayHeaderRefs.current.delete(day.day);
                }}
                onClick={() => toggleDay(day.day)}
                className="w-full flex items-center justify-between gap-2 px-0.5 pt-1 pb-1.5 text-left cursor-pointer"
                aria-expanded={isExpanded}
              >
                <div className="flex items-baseline gap-1.5 min-w-0">
                  {isExpanded ? (
                    <ChevronDown size={13} className="text-[#8b9199] flex-shrink-0" />
                  ) : (
                    <ChevronRight size={13} className="text-[#8b9199] flex-shrink-0" />
                  )}
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: dayColor(day.day - 1) }}
                  />
                  <span className="text-[11px] font-bold uppercase tracking-wide text-[#f2ede3] font-mono flex-shrink-0">
                    День {day.day}
                  </span>
                  <span className="text-[11px] font-mono text-[#8b9199] flex-shrink-0">
                    · ~{formatDuration(day.total_s)}
                  </span>
                  <span className="text-[10px] text-[#5a5f66] flex-shrink-0">
                    · {dayStops.length} {dayStops.length === 1 ? 'остановка' : dayStops.length < 5 ? 'остановки' : 'остановок'}
                  </span>
                  {day.lodging && (
                    <span className="text-[10px] text-[#16a085] truncate">· 🛏 {day.lodging.name}</span>
                  )}
                </div>
              </button>

              {isExpanded && (
                <div className="pb-1.5">
                  <div className="space-y-1.5">
                    {dayStops.map((stop) => (
                      <FinalizedStopCard
                        key={stop.id}
                        stop={stop}
                        isSelected={selectedStopId === stop.id}
                        order={orderById.get(stop.id) ?? 0}
                        onSelectStop={onSelectStop}
                      />
                    ))}
                  </div>
                  {day.lodging && <LodgingLine lodging={day.lodging} />}
                  {mapsUrl && (
                    <a
                      href={mapsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 mt-1.5 rounded text-[11px] font-medium text-[#8b9199] border border-[#2c3138] hover:border-[#3a4048] hover:text-[#f2ede3] transition-colors"
                    >
                      <Navigation size={12} className="flex-shrink-0" />
                      Открыть день в Google Maps
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {trip.enrichment.sources.length > 0 && (
          <div className="mt-3 pt-2.5 border-t border-[#2c3138]">
            <div className="text-[9px] uppercase tracking-wide text-[#5a5f66] font-mono mb-1 px-0.5">
              Источники
            </div>
            <div className="flex flex-col gap-1 px-0.5">
              {trip.enrichment.sources.map((source, i) => (
                <a
                  key={i}
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-[#6a9fd8] hover:underline truncate"
                >
                  {source.title}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="p-2.5 border-t border-black flex-shrink-0">
        <p className="text-[10px] text-[#5a5f66] leading-snug mb-2 text-center">
          Финальная версия неизменна. Черновик можно продолжать редактировать отдельно.
        </p>
        <button
          onClick={onEditDraft}
          className="w-full px-3 py-2.5 rounded text-[12px] font-semibold bg-[#2c3138] text-[#f2ede3] border border-[#3a4048] hover:bg-[#3a4048] transition-colors cursor-pointer"
        >
          Редактировать черновик
        </button>
      </div>
    </aside>
  );
});

FinalizedView.displayName = 'FinalizedView';
