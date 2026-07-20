import React, { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, Star } from 'lucide-react';
import { LodgingOption, PreviewDay, SelectedLodging } from '../api';
import { formatDuration } from '../format';
import { dayColor } from '../dayColors';

export interface LodgingSelectionModalProps {
  isOpen: boolean;
  days: PreviewDay[];
  onContinue: (selected: SelectedLodging[]) => void;
  onSkip: () => void;
  onCancel: () => void;
}

const formatDistance = (m: number): string =>
  m < 1000 ? `в ${Math.round(m)} м` : `в ${(m / 1000).toFixed(1)} км`;

const formatPriceLevel = (level: number | null): string | null =>
  level ? '$'.repeat(level) : null;

const LodgingCard: React.FC<{
  option: LodgingOption;
  dayNumber: number;
  isSelected: boolean;
  onSelect: () => void;
}> = ({ option, dayNumber, isSelected, onSelect }) => {
  const price = formatPriceLevel(option.price_level);

  return (
    <label
      className={`flex gap-2.5 p-2.5 rounded border cursor-pointer transition-colors ${
        isSelected ? 'bg-[#2c3138] border-[#e8b53f]' : 'bg-[#1a1d21] border-transparent hover:bg-[#22262b]'
      }`}
    >
      <input
        type="radio"
        name={`lodging-day-${dayNumber}`}
        checked={isSelected}
        onChange={onSelect}
        className="mt-1 flex-shrink-0 accent-[#e8b53f] cursor-pointer"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[14px] font-medium text-[#f2ede3] truncate">{option.name}</div>
          {price && <span className="text-[11px] font-mono text-[#8b9199] flex-shrink-0">{price}</span>}
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11px] font-mono text-[#8b9199]">
          {option.rating != null ? (
            <span className="flex items-center gap-0.5">
              <Star size={11} className="text-[#e8b53f] flex-shrink-0" fill="currentColor" />
              {option.rating.toFixed(1)}
              {option.user_ratings_total != null && ` (${option.user_ratings_total})`}
            </span>
          ) : (
            <span>без рейтинга</span>
          )}
          <span>·</span>
          <span>{formatDistance(option.distance_m)}</span>
        </div>
        {option.vicinity && (
          <div className="text-[11px] text-[#5a5f66] truncate mt-0.5">{option.vicinity}</div>
        )}
        <a
          href={option.maps_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 text-[10px] text-[#6a9fd8] hover:underline mt-1"
        >
          Открыть в Google Maps
          <ExternalLink size={10} />
        </a>
      </div>
    </label>
  );
};

const DayLodgingSection: React.FC<{
  day: PreviewDay;
  selected: LodgingOption | null;
  onSelect: (option: LodgingOption) => void;
}> = ({ day, selected, onSelect }) => (
  <div>
    <div className="flex items-center justify-between gap-2 px-0.5 pb-1.5">
      <div className="flex items-baseline gap-1.5 min-w-0">
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
        {day.end_point.near_stop_name && (
          <span className="text-[10px] text-[#5a5f66] truncate">
            · до {day.end_point.near_stop_name}
          </span>
        )}
      </div>
      {day.over_limit && (
        // Same either-cause flag as PlanPanel's badge (see its comment) —
        // day_split.py's over_limit no longer means "driving time" specifically.
        <span
          className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-[#c05640] font-mono flex-shrink-0"
          title="Этот день превышает лимит вождения или бодрствования"
        >
          <AlertTriangle size={10} className="flex-shrink-0" />
          день перегружен
        </span>
      )}
    </div>

    {day.lodging_options.length === 0 ? (
      <p className="text-[11px] text-[#5a5f66] px-2.5 py-2">Жильё не найдено для этого дня.</p>
    ) : (
      <div className="space-y-1.5">
        {day.lodging_options.map((option) => (
          <LodgingCard
            key={option.place_id}
            option={option}
            dayNumber={day.day}
            isSelected={selected?.place_id === option.place_id}
            onSelect={() => onSelect(option)}
          />
        ))}
      </div>
    )}
  </div>
);

// Sits between the free preview (finalize-preview) and the paywall/confirm
// step — shown only when needs_selection is true (App.tsx skips straight to
// the paywall/confirm otherwise). Selection lives in this component's own
// state, not draft_state: it's a one-time choice for THIS finalize attempt,
// not part of the editable draft.
export const LodgingSelectionModal: React.FC<LodgingSelectionModalProps> = ({
  isOpen, days, onContinue, onSkip, onCancel,
}) => {
  const [selectedByDay, setSelectedByDay] = useState<Map<number, LodgingOption>>(new Map());

  // Re-initializes to "first option per day" whenever a fresh preview comes
  // in — the modal stays mounted (only its CSS visibility toggles, same
  // pattern as the other modals here), so without this a second finalize
  // attempt would reopen with stale selections from the last one.
  useEffect(() => {
    const initial = new Map<number, LodgingOption>();
    for (const day of days) {
      if (day.lodging_options.length > 0) {
        initial.set(day.day, day.lodging_options[0]);
      }
    }
    setSelectedByDay(initial);
  }, [days]);

  const pickableDays = days.slice(0, -1); // last day never gets a night after it

  const handleContinue = () => {
    const selected: SelectedLodging[] = [];
    for (const day of pickableDays) {
      const option = selectedByDay.get(day.day);
      if (option) {
        selected.push({
          day: day.day,
          place_id: option.place_id,
          lat: option.lat,
          lon: option.lon,
          name: option.name,
          rating: option.rating,
          vicinity: option.vicinity,
        });
      }
    }
    onContinue(selected);
  };

  return (
    <div className={`modal ${isOpen ? 'on' : ''}`}>
      <div className="modal-box" style={{ width: 560, maxWidth: '94vw' }}>
        <div className="flex items-center justify-between mb-1">
          <h2>Выберите ночёвки</h2>
          <button
            onClick={onCancel}
            className="text-[#8b9199] hover:text-[#f2ede3] text-lg leading-none cursor-pointer"
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>
        <p className="text-[11px] text-[#8b9199] -mt-1 mb-3">
          Дни и время — по предварительной оценке, уточнятся после оплаты.
        </p>

        <div className="max-h-[55vh] overflow-y-auto space-y-4 pr-1">
          {pickableDays.map((day) => (
            <DayLodgingSection
              key={day.day}
              day={day}
              selected={selectedByDay.get(day.day) ?? null}
              onSelect={(option) => {
                setSelectedByDay((prev) => {
                  const next = new Map(prev);
                  next.set(day.day, option);
                  return next;
                });
              }}
            />
          ))}
        </div>

        <div className="flex gap-3 justify-end mt-4">
          <button
            className="px-4 py-2 text-xs font-semibold rounded bg-[#3a4048] text-white hover:bg-opacity-80 cursor-pointer"
            onClick={onSkip}
          >
            Пропустить
          </button>
          <button
            className="px-4 py-2 text-xs font-semibold rounded bg-[#e8b53f] text-[#14171a] hover:bg-opacity-80 cursor-pointer"
            onClick={handleContinue}
          >
            Продолжить с выбранными
          </button>
        </div>
      </div>
    </div>
  );
};
