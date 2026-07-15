import React, { useState } from 'react';
import { SavedTrip } from '../types';
import { Archive, Trash2, ArrowLeft, ChevronDown, ChevronRight, Compass } from 'lucide-react';

export interface TripsListProps {
  trips: SavedTrip[];
  onOpen: (id: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onBack: () => void;
  onNew: () => void;
}

export const TripsList: React.FC<TripsListProps> = ({
  trips,
  onOpen,
  onArchive,
  onDelete,
  onBack,
  onNew,
}) => {
  const [archiveExpanded, setArchiveExpanded] = useState<boolean>(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Group trips into active vs archived
  const activeTrips = trips.filter((t) => t.status !== 'archived');
  const archivedTrips = trips.filter((t) => t.status === 'archived');

  const formatUpdateDate = (isoStr: string) => {
    try {
      return new Date(isoStr).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoStr;
    }
  };

  const getDaysLabel = (answers: Record<string, string | string[]>) => {
    const days = answers.days;
    if (!days) return '3–4 дня';
    return Array.isArray(days) ? days[0] : days;
  };

  // Helper to render a trip card
  const renderTripCard = (trip: SavedTrip) => {
    const isConfirmingDelete = confirmDeleteId === trip.id;

    // Badges definitions based on status
    let badgeBg = '#e4dccd';
    let badgeText = '#6c727a';
    let badgeBorder = 'transparent';

    if (trip.status === 'ready') {
      badgeBg = '#6f8b6e';
      badgeText = '#f2ede3';
    } else if (trip.status === 'completed') {
      badgeBg = '#3a4048';
      badgeText = '#f2ede3';
    } else if (trip.status === 'archived') {
      badgeBg = 'transparent';
      badgeBorder = '#e4dccd';
      badgeText = '#8b9199';
    }

    return (
      <div
        key={trip.id}
        className="group relative p-4 rounded bg-[#f2ede3] text-[#14171a] border border-[#e4dccd] shadow-sm transition-all hover:shadow hover:translate-y-[-1px] flex flex-col gap-1 overflow-hidden"
      >
        {/* Top line with title and status badge */}
        <div className="flex items-start justify-between gap-2 pr-12">
          <span
            onClick={() => !isConfirmingDelete && onOpen(trip.id)}
            className="font-bold text-sm text-[#14171a] hover:text-[#c05640] cursor-pointer transition-colors leading-tight"
          >
            {trip.title || `${trip.origin} → ${trip.dest}`}
          </span>
          
          <span
            className="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0 select-none"
            style={{
              backgroundColor: badgeBg,
              color: badgeText,
              border: badgeBorder !== 'transparent' ? `1px solid ${badgeBorder}` : 'none',
            }}
          >
            {trip.status === 'draft' && 'Черновик'}
            {trip.status === 'ready' && 'Готов'}
            {trip.status === 'completed' && 'Завершён'}
            {trip.status === 'archived' && 'Архив'}
          </span>
        </div>

        {/* Route Details */}
        <div className="font-mono text-[11px] text-[#6c727a] mt-0.5 select-none">
          {trip.origin} → {trip.dest}
        </div>

        {/* Metadata */}
        <div className="font-mono text-[10px] text-[#8b9199] mt-2 select-none">
          {getDaysLabel(trip.answers)} · {formatUpdateDate(trip.updatedAt)}
        </div>

        {/* Confirmation or Actions Overlay */}
        {isConfirmingDelete ? (
          <div className="absolute inset-0 bg-[#f2ede3]/95 flex items-center justify-between px-4 py-2 transition-all z-10">
            <span className="text-xs font-semibold text-[#c05640] font-mono">Удалить поездку?</span>
            <div className="flex gap-2">
              <button
                onClick={() => onDelete(trip.id)}
                className="px-2.5 py-1 text-[10px] font-bold rounded bg-[#c05640] text-white hover:bg-[#a6432f] transition-colors cursor-pointer"
              >
                Да
              </button>
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="px-2.5 py-1 text-[10px] font-bold rounded bg-[#3a4048] text-white hover:bg-opacity-90 transition-colors cursor-pointer"
              >
                Нет
              </button>
            </div>
          </div>
        ) : (
          /* Hover Actions Panel */
          <div className="absolute right-3 bottom-3 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center gap-2 bg-[#f2ede3] pl-2 rounded-l">
            {trip.status !== 'archived' && (
              <button
                onClick={() => onArchive(trip.id)}
                className="p-1.5 rounded hover:bg-[#e4dccd] text-[#6c727a] hover:text-[#14171a] transition-all cursor-pointer"
                title="Архивировать"
              >
                <Archive size={14} />
              </button>
            )}
            <button
              onClick={() => setConfirmDeleteId(trip.id)}
              className="p-1.5 rounded hover:bg-[#e4dccd] text-[#6c727a] hover:text-[#c05640] transition-all cursor-pointer"
              title="Удалить"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#14171a] min-h-0">
      
      {/* List Header */}
      <div className="head flex items-center justify-between py-3.5 px-5 border-b border-[#000000] flex-shrink-0">
        <h2 className="text-sm font-semibold text-white uppercase tracking-wider">Мои поездки</h2>
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-[#8b9199] hover:text-white transition-colors cursor-pointer"
        >
          <ArrowLeft size={13} />
          <span>Назад</span>
        </button>
      </div>

      {/* Main Container Area */}
      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        
        {/* Active Trips Section */}
        <div className="space-y-3">
          {activeTrips.length === 0 ? (
            /* Empty state for active trips */
            <div className="flex flex-col items-center justify-center text-center py-12 px-4 rounded border border-dashed border-[#3a4048] bg-[#22262b]/30">
              <Compass size={32} className="text-[#8b9199] mb-3 stroke-[1.5]" />
              <p className="text-xs text-[#f2ede3] font-medium">Здесь появятся ваши поездки</p>
              <p className="text-[11px] text-[#8b9199] mt-1 mb-4 font-mono max-w-[200px] mx-auto">
                Пройдите квиз, чтобы сохранить первый маршрут.
              </p>
              <button
                onClick={onNew}
                className="px-4 py-2 text-xs font-semibold rounded bg-[#e8b53f] text-[#14171a] hover:bg-[#d4a230] transition-colors cursor-pointer"
              >
                Спланировать первую
              </button>
            </div>
          ) : (
            activeTrips.map(renderTripCard)
          )}
        </div>

        {/* Archived Section */}
        {archivedTrips.length > 0 && (
          <div className="border-t border-[#2c3138] pt-4 mt-4">
            <button
              onClick={() => setArchiveExpanded(!archiveExpanded)}
              className="w-full flex items-center justify-between text-xs text-[#8b9199] hover:text-white py-1.5 transition-colors font-semibold uppercase tracking-wider cursor-pointer"
            >
              <span>Архив ({archivedTrips.length})</span>
              {archiveExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>

            {archiveExpanded && (
              <div className="space-y-3 mt-3 animate-fadeIn">
                {archivedTrips.map(renderTripCard)}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
};
