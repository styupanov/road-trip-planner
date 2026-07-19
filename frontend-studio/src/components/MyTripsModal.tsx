import React, { useState } from 'react';
import { TripSummary } from '../api';

export interface MyTripsModalProps {
  isOpen: boolean;
  trips: TripSummary[];
  isLoading: boolean;
  onClose: () => void;
  // status is the caller's INTENT ('draft' -> open the editor, 'finalized' ->
  // open the read-only result), not necessarily trip.status verbatim — a
  // finalized trip's card offers both actions (see FinalizedTripCard below),
  // so "Редактировать черновик" passes 'draft' even though the trip's own
  // status is 'finalized'. App.tsx's handleOpenTripFromList branches on
  // exactly this argument.
  onOpenTrip: (id: string, status: string) => void;
  onDeleteTrip: (id: string) => void;
}

const formatUpdatedAt = (iso: string): string => {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

const TripCard: React.FC<{
  trip: TripSummary;
  onOpen: () => void;
  onDelete: () => void;
}> = ({ trip, onOpen, onDelete }) => {
  const [confirming, setConfirming] = useState(false);

  const title = trip.origin_name && trip.destination_name
    ? `${trip.origin_name} → ${trip.destination_name}`
    : trip.title || 'Без названия';

  if (confirming) {
    return (
      <div className="flex items-center justify-between gap-2 p-3 rounded bg-[#1a1d21]">
        <span className="text-[12px] text-[#f2ede3]">Удалить поездку?</span>
        <div className="flex gap-2 flex-shrink-0">
          <button
            className="px-2.5 py-1 text-[11px] font-semibold rounded bg-[#3a4048] text-white hover:bg-opacity-80 cursor-pointer"
            onClick={() => setConfirming(false)}
          >
            Отмена
          </button>
          <button
            className="px-2.5 py-1 text-[11px] font-semibold rounded bg-[#c05640] text-white hover:bg-opacity-80 cursor-pointer"
            onClick={onDelete}
          >
            Удалить
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 p-3 rounded bg-[#1a1d21] border border-transparent hover:border-[#3a4048] transition-colors">
      <button className="min-w-0 flex-1 text-left cursor-pointer" onClick={onOpen}>
        <div className="text-[13px] font-medium text-[#f2ede3] truncate">{title}</div>
        <div className="text-[10px] text-[#8b9199] font-mono mt-0.5">
          Обновлено {formatUpdatedAt(trip.updated_at)}
        </div>
      </button>
      <button
        className="flex-shrink-0 text-[#8b9199] hover:text-[#c05640] transition-colors text-sm px-1.5 cursor-pointer"
        onClick={() => setConfirming(true)}
        aria-label="Удалить поездку"
        title="Удалить поездку"
      >
        ✕
      </button>
    </div>
  );
};

// A finalized trip_project still has its (frozen-in-place, but still there)
// draft_state underneath the immutable trip_versions snapshot — this card
// surfaces both explicitly, instead of the draft silently becoming
// unreachable once a project's status flips to 'finalized' (see App.tsx's
// handleOpenTripFromList: "Редактировать черновик" passes status='draft' on
// purpose, overriding trip.status, to reach the same restore path a draft
// card's single click uses).
const FinalizedTripCard: React.FC<{
  trip: TripSummary;
  onViewFinalized: () => void;
  onEditDraft: () => void;
  onDelete: () => void;
}> = ({ trip, onViewFinalized, onEditDraft, onDelete }) => {
  const [confirming, setConfirming] = useState(false);

  const title = trip.origin_name && trip.destination_name
    ? `${trip.origin_name} → ${trip.destination_name}`
    : trip.title || 'Без названия';

  if (confirming) {
    return (
      <div className="flex items-center justify-between gap-2 p-3 rounded bg-[#1a1d21]">
        <span className="text-[12px] text-[#f2ede3]">Удалить поездку?</span>
        <div className="flex gap-2 flex-shrink-0">
          <button
            className="px-2.5 py-1 text-[11px] font-semibold rounded bg-[#3a4048] text-white hover:bg-opacity-80 cursor-pointer"
            onClick={() => setConfirming(false)}
          >
            Отмена
          </button>
          <button
            className="px-2.5 py-1 text-[11px] font-semibold rounded bg-[#c05640] text-white hover:bg-opacity-80 cursor-pointer"
            onClick={onDelete}
          >
            Удалить
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 rounded bg-[#1a1d21] border border-transparent hover:border-[#3a4048] transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[#f2ede3] truncate">{title}</div>
          <div className="text-[10px] text-[#8b9199] font-mono mt-0.5">
            Обновлено {formatUpdatedAt(trip.updated_at)}
          </div>
        </div>
        <button
          className="flex-shrink-0 text-[#8b9199] hover:text-[#c05640] transition-colors text-sm px-1.5 cursor-pointer"
          onClick={() => setConfirming(true)}
          aria-label="Удалить поездку"
          title="Удалить поездку"
        >
          ✕
        </button>
      </div>
      <div className="flex gap-2 mt-2">
        <button
          className="px-2.5 py-1.5 text-[11px] font-semibold rounded bg-[#e8b53f] text-[#14171a] hover:opacity-90 transition-opacity cursor-pointer"
          onClick={onViewFinalized}
        >
          Смотреть финал
        </button>
        <button
          className="px-2.5 py-1.5 text-[11px] font-semibold rounded bg-[#2c3138] text-[#f2ede3] border border-[#3a4048] hover:bg-[#3a4048] transition-colors cursor-pointer"
          onClick={onEditDraft}
        >
          Редактировать черновик
        </button>
      </div>
    </div>
  );
};

export const MyTripsModal: React.FC<MyTripsModalProps> = ({
  isOpen,
  trips,
  isLoading,
  onClose,
  onOpenTrip,
  onDeleteTrip,
}) => {
  const drafts = trips.filter(t => t.status === 'draft');
  const finalized = trips.filter(t => t.status === 'finalized');

  return (
    <div className={`modal ${isOpen ? 'on' : ''}`} id="my-trips-modal">
      {/* Wider than the default 340px .modal-box (inline style wins over the
          CSS class regardless of stylesheet order) — a trip list needs more
          room than a couple of sign-in buttons. */}
      <div className="modal-box" style={{ width: 440, maxWidth: '92vw' }}>
        <div className="flex items-center justify-between mb-1">
          <h2>Мои поездки</h2>
          <button
            onClick={onClose}
            className="text-[#8b9199] hover:text-[#f2ede3] text-lg leading-none cursor-pointer"
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>

        {isLoading ? (
          <p className="text-[12px] text-[#8b9199] mt-3">Загрузка…</p>
        ) : trips.length === 0 ? (
          <p className="text-[12px] text-[#8b9199] mt-3">Поездок пока нет.</p>
        ) : (
          <div className="mt-3 max-h-[60vh] overflow-y-auto space-y-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[#5a5f66] font-mono mb-1.5">
                Черновики
              </div>
              {drafts.length > 0 ? (
                <div className="space-y-1.5">
                  {drafts.map(trip => (
                    <TripCard
                      key={trip.id}
                      trip={trip}
                      onOpen={() => onOpenTrip(trip.id, 'draft')}
                      onDelete={() => onDeleteTrip(trip.id)}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-[#5a5f66]">Нет черновиков.</p>
              )}
            </div>

            {/* Фаза 3, подшаг 3: live now — a finalized project keeps its
                draft_state underneath the immutable snapshot, so each card
                offers both "Смотреть финал" and "Редактировать черновик"
                rather than picking one (see FinalizedTripCard). Still hidden
                entirely while empty. */}
            {finalized.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-[#5a5f66] font-mono mb-1.5">
                  Финализированные
                </div>
                <div className="space-y-1.5">
                  {finalized.map(trip => (
                    <FinalizedTripCard
                      key={trip.id}
                      trip={trip}
                      onViewFinalized={() => onOpenTrip(trip.id, 'finalized')}
                      onEditDraft={() => onOpenTrip(trip.id, 'draft')}
                      onDelete={() => onDeleteTrip(trip.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
