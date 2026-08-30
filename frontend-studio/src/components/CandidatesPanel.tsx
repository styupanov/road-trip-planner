import React from 'react';
import { Plus } from 'lucide-react';
import { ApiStop } from '../api';
import { formatDetour } from '../format';
import { dayColor } from '../dayColors';

export interface CandidateWithDay {
  stop: ApiStop;
  // From dayAttribution.ts::attributeCandidateToDay (Шаг 0) — null when
  // there's no day-split to attribute against yet (draft before its first
  // live route-through/day-split response), not a per-candidate failure.
  day: number | null;
}

export interface CandidatesPanelProps {
  candidates: CandidateWithDay[];
  // The ribbon's currently active day (Шаг 2) — null means no split exists
  // yet, in which case filtering is impossible and every candidate shows
  // unfiltered (decided in Шаг 3's own spec: "до появления разбивки видны
  // все").
  activeDay: number | null;
  onAddStop: (id: number) => void;
}

const CandidateRow: React.FC<{ candidate: CandidateWithDay; onAddStop: (id: number) => void }> = ({
  candidate, onAddStop,
}) => {
  const { stop, day } = candidate;
  return (
    <div
      onClick={() => onAddStop(stop.id)}
      className="group w-full text-left p-2.5 rounded border border-dashed border-[#3a4048] bg-[#1a1d21] hover:border-[#e8b53f] hover:border-solid hover:bg-[#22262b] transition-colors cursor-pointer flex gap-2.5 items-center"
    >
      <Plus size={15} className="flex-shrink-0 text-[#e8b53f]" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-[#f2ede3] truncate">{stop.name}</div>
        <div className="text-[11px] text-[#8b9199] font-mono truncate">
          {stop.category} · {formatDetour(stop.detour_s)}
          {stop.rating != null ? ` · ★${stop.rating.toFixed(1)}` : ''}
        </div>
      </div>
      {day != null && (
        <span
          className="flex-shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded"
          style={{ backgroundColor: `${dayColor(day - 1)}30`, color: dayColor(day - 1) }}
        >
          день {day}
        </span>
      )}
    </div>
  );
};

// Candidates panel (Шаг 3) — not-yet-included stops near the route,
// filtered to the ribbon's active day once a day-split exists (Шаг 0's
// attributeCandidateToDay, applied in App.tsx before this component ever
// sees the list — this component only decides WHETHER to filter, not HOW).
export const CandidatesPanel: React.FC<CandidatesPanelProps> = ({ candidates, activeDay, onAddStop }) => {
  const filtered = activeDay != null ? candidates.filter((c) => c.day === activeDay) : candidates;

  return (
    <section className="h-full min-w-0 min-h-0 flex flex-col bg-[#14171a] border border-black rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-black flex-shrink-0">
        <h2 className="text-[15px] font-semibold text-[#f2ede3]">
          Рядом с маршрутом
          {activeDay != null && (
            <span className="text-[12px] font-normal text-[#8b9199]"> · день {activeDay}</span>
          )}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
        {filtered.map(({ stop, day }) => (
          <CandidateRow key={stop.id} candidate={{ stop, day }} onAddStop={onAddStop} />
        ))}
        {filtered.length === 0 && (
          <p className="text-[12px] text-[#8b9199] text-center mt-4">
            {candidates.length === 0 ? 'Рядом больше ничего не нашлось.' : 'Рядом с этим днём ничего не нашлось.'}
          </p>
        )}
      </div>
    </section>
  );
};
