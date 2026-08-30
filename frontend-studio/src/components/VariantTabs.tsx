import React from 'react';
import { RouteOption, RouteThroughSummary } from '../api';
import { formatDuration } from '../format';

export interface VariantTabsProps {
  options: RouteOption[];
  activeOptionIndex: number;
  onSelectTab: (index: number) => void;
  includedByOption: Map<number, Set<number>>;
  routeThroughByOption: Map<number, RouteThroughSummary>;
  // /route-through in flight for the ACTIVE tab specifically — same meaning
  // PlanPanel's own isRecomputing had.
  isRecomputing: boolean;
}

// Variant/option tabs (Шаг 3) — same onSelectTab logic PlanPanel already
// had, just moved under the map (per the reference prototype) and now also
// showing the per-option summary PlanPanel used to show separately, above
// the day list, only for the active tab (stop count/rating/delta_s к
// прямому пути) — the prototype's own tabs already carry this same summary
// per tab, not just the active one, so every option's headline number is
// visible without switching.
export const VariantTabs: React.FC<VariantTabsProps> = ({
  options, activeOptionIndex, onSelectTab, includedByOption, routeThroughByOption, isRecomputing,
}) => {
  if (options.length <= 1) return null;

  return (
    <div className="flex gap-1.5 px-4 pt-2.5 flex-shrink-0">
      {options.map((option, idx) => {
        const isActive = idx === activeOptionIndex;
        const includedCount = includedByOption.get(idx)?.size ?? 0;
        const through = routeThroughByOption.get(idx);
        // Never mix a Valhalla-sourced delta_s with anything else — same
        // "one measuring stick per number" rule PlanPanel's own comment had.
        const deltaS = through?.delta_s ?? option.delta_s;

        return (
          <button
            key={option.index}
            onClick={() => onSelectTab(idx)}
            className={`flex-1 min-w-0 text-left px-3 py-2 rounded-lg text-[11px] transition-colors cursor-pointer border ${
              isActive
                ? 'bg-[#e8b53f]/10 border-[#e8b53f]'
                : 'bg-[#1a1d21] border-black hover:border-[#3a4048]'
            }`}
          >
            <div className={`font-mono font-semibold uppercase tracking-wide ${isActive ? 'text-[#e8b53f]' : 'text-[#8b9199]'}`}>
              Вариант {idx + 1}
            </div>
            <div className="text-[12px] text-[#c7cdd4] mt-0.5 truncate">
              {includedCount} остановок
              {option.avg_rating != null ? ` · ★${option.avg_rating.toFixed(1)}` : ''}
            </div>
            <div className="text-[11px] font-mono text-[#8b9199] truncate">
              {deltaS != null ? (
                <>+{formatDuration(deltaS)} к прямому пути <span className="text-[10px]">(оценка)</span></>
              ) : (
                'крюк ещё не посчитан'
              )}
              {isActive && isRecomputing && ' · пересчитываем…'}
            </div>
          </button>
        );
      })}
    </div>
  );
};
