import React from 'react';
import { DayResult } from '../api';
import { formatDuration } from '../format';
import { dayColor } from '../dayColors';

// Floor on a day's flex-basis (seconds) so a very short/degenerate day
// never collapses to an unreadable sliver — mirrors the same "minimum
// width so the label fits" reasoning as the reference prototype's own
// Math.max(total, 60) (minutes there; this is seconds).
const MIN_BLOCK_FLEX_BASIS_S = 1800;
const MIN_BLOCK_WIDTH_PX = 90;

export interface DayRibbonProps {
  // Empty (or absent upstream) means "no split yet" — render nothing, per
  // this component's own spec (a draft before its first live route-through
  // response has no legs to split, see App.tsx's recomputeDaySplit).
  days: DayResult[];
  activeDay: number | null;
  onSelectDay: (day: number) => void;
  originLabel?: string | null;
  destLabel?: string | null;
}

// Horizontal day ribbon (Шаг 2 of the trip-editor UI migration) — indicator
// + active-day switcher ONLY. Day boundaries come entirely from day_split
// (via POST /day-split, see App.tsx) and are never draggable here — the
// divider between two blocks is a plain visual separator, not a control.
export const DayRibbon: React.FC<DayRibbonProps> = ({ days, activeDay, onSelectDay, originLabel, destLabel }) => {
  if (days.length === 0) return null;

  return (
    <div className="px-4 pt-2.5 pb-1.5 flex-shrink-0 border-b border-black bg-[#14171a]">
      {(originLabel || destLabel) && (
        <div className="flex justify-between text-[10px] font-mono uppercase tracking-wide text-[#5a5f66] mb-1">
          <span className="truncate">{originLabel || ''}</span>
          <span className="truncate">{destLabel || ''}</span>
        </div>
      )}

      <div className="flex h-[50px] select-none">
        {days.map((day, idx) => {
          const color = dayColor(day.day - 1);
          const isActive = day.day === activeDay;
          const isFirst = idx === 0;
          const isLast = idx === days.length - 1;

          return (
            <React.Fragment key={day.day}>
              {idx > 0 && (
                // Purely visual — day boundaries come from day_split, never
                // draggable/interactive here.
                <div className="w-3 flex-none flex items-center justify-center">
                  <div className="w-[3px] h-[66%] rounded-full bg-[#3a4048]" />
                </div>
              )}
              <button
                type="button"
                onClick={() => onSelectDay(day.day)}
                title={`День ${day.day}`}
                className={`relative flex flex-col items-center justify-center gap-0.5 overflow-hidden cursor-pointer transition-[filter] hover:brightness-125 ${
                  isFirst ? 'rounded-l-[10px]' : ''
                } ${isLast ? 'rounded-r-[10px]' : ''} ${
                  isActive ? 'outline outline-2 outline-[#e8b53f] -outline-offset-2 z-[2]' : ''
                }`}
                style={{
                  flex: `${Math.max(day.total_s, MIN_BLOCK_FLEX_BASIS_S)} 1 ${MIN_BLOCK_WIDTH_PX}px`,
                  backgroundColor: `${color}38`,
                  color,
                }}
              >
                <span className="text-[11px] font-mono font-medium whitespace-nowrap">
                  ДЕНЬ {day.day}
                </span>
                <span
                  className="text-[11px] whitespace-nowrap"
                  style={day.over_limit ? { color: '#c05640', opacity: 1 } : { opacity: 0.8 }}
                >
                  {day.over_limit
                    ? `${formatDuration(day.drive_s)} · перегружен`
                    : `${formatDuration(day.drive_s)} · ${day.stop_indices.length} ост.`}
                </span>
              </button>
            </React.Fragment>
          );
        })}
      </div>

      {/* Lodging captions at day boundaries — in the DRAFT there's no
          lodging yet (it's only picked at finalize, see
          LodgingSelectionModal/relodge) — no data to show and nothing here
          can act on a click, so a muted, non-interactive caption is the
          honest choice: it explains why the boundary is unlabeled instead
          of silently looking incomplete, without implying a "+ выбрать"
          affordance this step doesn't wire up to anything. */}
      {days.length > 1 && (
        <div className="flex h-5 mt-1">
          <div style={{ flex: `${Math.max(days[0].total_s, MIN_BLOCK_FLEX_BASIS_S)} 1 ${MIN_BLOCK_WIDTH_PX}px` }} />
          {days.slice(1).map((day) => (
            <React.Fragment key={`lodging-${day.day}`}>
              <div className="w-3 flex-none relative">
                <span className="absolute top-0 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] text-[#5a5f66]">
                  ночёвка — при финализации
                </span>
              </div>
              <div style={{ flex: `${Math.max(day.total_s, MIN_BLOCK_FLEX_BASIS_S)} 1 ${MIN_BLOCK_WIDTH_PX}px` }} />
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
};
