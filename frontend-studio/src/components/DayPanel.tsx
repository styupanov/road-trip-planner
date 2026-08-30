import React from 'react';
import { AlertTriangle, ArrowUpRight, BedDouble, X } from 'lucide-react';
import { ApiStop, DayResult } from '../api';
import { formatDuration, formatDetour } from '../format';
import { dayColor } from '../dayColors';

export interface DayPanelProps {
  // null: no split yet (draft before its first live route-through/day-split
  // response) or no day selected — render an empty/placeholder state.
  day: DayResult | null;
  dayStops: ApiStop[];
  isLastDay: boolean;
  selectedStopId: number | null;
  onSelectStop: (id: number) => void;
  onToggleStop: (id: number) => void;
}

// Field selection mirrors PlanPanel's own PlanStopRow (category/name/
// rating/detour, deliberately no absolute times) plus "время на месте"
// (stop.duration), which PlanStopRow never rendered — added here per Шаг
// 3's own field list. A dedicated remove button, not a checkbox: every row
// here is already-included by definition (this is the active day's OWN
// stop list, not a mixed included/excluded list PlanStopRow had to
// distinguish) — matches the reference prototype's own hover-revealed "✕"
// pattern for exactly this context.
const DayStopRow: React.FC<{
  stop: ApiStop;
  order: number;
  isSelected: boolean;
  onSelectStop: (id: number) => void;
  onToggleStop: (id: number) => void;
}> = ({ stop, order, isSelected, onSelectStop, onToggleStop }) => (
  <div
    onClick={() => onSelectStop(stop.id)}
    className={`group w-full text-left p-2.5 rounded transition-colors cursor-pointer border flex gap-2.5 ${
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
      <div className="flex items-center justify-between mt-1.5 gap-2">
        <span className="text-[11px] font-mono text-[#8b9199] flex-shrink-0">
          {stop.rating != null ? `★ ${stop.rating.toFixed(1)}` : 'без рейтинга'}
          {stop.review_count != null ? ` · ${stop.review_count}` : ''}
        </span>
        <span className="text-[11px] font-mono text-[#8b9199] flex items-center gap-1 text-right flex-shrink-0">
          {formatDetour(stop.detour_s)}
          <ArrowUpRight size={11} className="flex-shrink-0" />
        </span>
      </div>
      {stop.duration && (
        <div className="text-[11px] text-[#5a5f66] mt-1">Время на месте: {stop.duration}</div>
      )}
    </div>
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggleStop(stop.id); }}
      title="Убрать остановку из маршрута"
      aria-label="Убрать остановку из маршрута"
      className="flex-shrink-0 self-start p-1 rounded text-[#5a5f66] opacity-0 group-hover:opacity-100 hover:text-[#c05640] hover:bg-[#c05640]/10 transition-opacity cursor-pointer"
    >
      <X size={14} />
    </button>
  </div>
);

// Active-day panel (Шаг 3 of the trip-editor UI migration) — replaces
// PlanPanel's stop list for the day the ribbon (Шаг 2) has selected. Pure
// presentational: App.tsx resolves `day`/`dayStops` from
// dayRibbonByOption/activeDayInDraft, this component just renders them.
export const DayPanel: React.FC<DayPanelProps> = ({
  day, dayStops, isLastDay, selectedStopId, onSelectStop, onToggleStop,
}) => {
  if (!day) {
    return (
      <section className="h-full min-w-0 min-h-0 flex flex-col bg-[#14171a] border border-black rounded-xl overflow-hidden items-center justify-center p-4">
        <p className="text-[12px] text-[#8b9199] text-center">
          Разбивка по дням появится, как только маршрут посчитается.
        </p>
      </section>
    );
  }

  return (
    <section className="h-full min-w-0 min-h-0 flex flex-col bg-[#14171a] border border-black rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-black flex-shrink-0 flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: dayColor(day.day - 1) }}
          />
          <h2 className="text-[15px] font-semibold text-[#f2ede3] flex-shrink-0">День {day.day}</h2>
          <span className="text-[12px] font-mono text-[#8b9199] truncate">
            {formatDuration(day.drive_s)} за рулём{' '}
            {/* Same "(оценка)" convention PlanPanel already used — the draft
                only ever has Valhalla numbers (via /day-split), never
                Google's exact ones; the finalized view is where "(оценка)"
                becomes "(Google)" (Шаг 4, FinalizedView, untouched here). */}
            <span className="text-[10px]">(оценка)</span>
          </span>
        </div>
        {day.over_limit && (
          <span
            className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-[#c05640] font-mono flex-shrink-0"
            title="Этот день превышает лимит вождения или бодрствования"
          >
            <AlertTriangle size={10} className="flex-shrink-0" />
            день перегружен
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
        {dayStops.map((stop, idx) => (
          <DayStopRow
            key={stop.id}
            stop={stop}
            order={idx + 1}
            isSelected={selectedStopId === stop.id}
            onSelectStop={onSelectStop}
            onToggleStop={onToggleStop}
          />
        ))}
        {dayStops.length === 0 && (
          <p className="text-[12px] text-[#8b9199] text-center mt-4">В этот день остановок нет.</p>
        )}
      </div>

      {/* Ночёвка: в черновике ещё не выбирается (это происходит только при
          финализации — LodgingSelectionModal/relodge, оба не трогаем в
          этом шаге) — неинтерактивная подпись, честно объясняющая, почему
          строка пуста, а не подразумевающая нерабочую кнопку выбора. Тот
          же текст, что и в ленте (Шаг 2). Последний день ночёвки не
          получает — как везде в проекте (LodgingSelectionModal и т.д.). */}
      {!isLastDay && (
        <div className="flex-shrink-0 px-3 py-2.5 border-t border-black flex items-center gap-2 text-[12px] text-[#5a5f66]">
          <BedDouble size={13} className="flex-shrink-0" />
          <span>Ночёвка — при финализации</span>
        </div>
      )}
    </section>
  );
};
