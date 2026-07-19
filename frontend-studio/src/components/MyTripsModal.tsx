import React, { useState } from 'react';
import { TripSummary } from '../api';

export interface MyTripsModalProps {
  isOpen: boolean;
  trips: TripSummary[];
  isLoading: boolean;
  onClose: () => void;
  onOpenTrip: (id: string) => void;
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
                      onOpen={() => onOpenTrip(trip.id)}
                      onDelete={() => onDeleteTrip(trip.id)}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-[#5a5f66]">Нет черновиков.</p>
              )}
            </div>

            {/* Hidden entirely while empty, per spec — Finalize doesn't exist
                yet, so this section never actually has anything to show. */}
            {finalized.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-[#5a5f66] font-mono mb-1.5">
                  Финализированные
                </div>
                <div className="space-y-1.5">
                  {finalized.map(trip => (
                    <TripCard
                      key={trip.id}
                      trip={trip}
                      onOpen={() => onOpenTrip(trip.id)}
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
