import React, { useState } from 'react';
import { formatDateRangeRu } from '../format';

export interface DateModalProps {
  isOpen: boolean;
  onCancel: () => void;
  onConfirm: (tripDates: string | null) => void;
}

type DateMode = 'exact' | 'period' | 'unknown';

export const DateModal: React.FC<DateModalProps> = ({ isOpen, onCancel, onConfirm }) => {
  const [mode, setMode] = useState<DateMode>('unknown');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [periodText, setPeriodText] = useState('');

  const canConfirm =
    mode === 'unknown' ||
    (mode === 'exact' ? Boolean(dateFrom) && Boolean(dateTo) : periodText.trim() !== '');

  const handleConfirm = () => {
    if (!canConfirm) return;
    if (mode === 'unknown') {
      onConfirm(null);
    } else if (mode === 'period') {
      onConfirm(periodText.trim());
    } else {
      onConfirm(formatDateRangeRu(dateFrom, dateTo));
    }
  };

  return (
    <div className={`modal ${isOpen ? 'on' : ''}`}>
      <div className="modal-box">
        <h2>Когда планируете поездку?</h2>
        <p>
          Поможет найти события, сезонные особенности и закрытия по датам в местах остановок.
          Необязательно — можно пропустить.
        </p>

        <div className="opts mt-3">
          <button className={`opt ${mode === 'exact' ? 'on' : ''}`} onClick={() => setMode('exact')}>
            Точные даты
          </button>
          <button className={`opt ${mode === 'period' ? 'on' : ''}`} onClick={() => setMode('period')}>
            Период
          </button>
          <button className={`opt ${mode === 'unknown' ? 'on' : ''}`} onClick={() => setMode('unknown')}>
            Не знаю
          </button>
        </div>

        {mode === 'exact' && (
          <div className="flex gap-2 mt-3">
            <input
              type="date"
              className="q-in"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="Дата начала"
            />
            <input
              type="date"
              className="q-in"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="Дата окончания"
            />
          </div>
        )}

        {mode === 'period' && (
          <input
            type="text"
            className="q-in mt-3"
            placeholder="сентябрь 2026, начало октября…"
            value={periodText}
            onChange={(e) => setPeriodText(e.target.value)}
            autoFocus
          />
        )}

        <div className="flex gap-3 justify-end mt-4">
          <button
            className="px-4 py-2 text-xs font-semibold rounded bg-[#3a4048] text-white hover:bg-opacity-80"
            onClick={onCancel}
          >
            Отмена
          </button>
          <button
            className="px-4 py-2 text-xs font-semibold rounded bg-[#e8b53f] text-[#14171a] hover:bg-opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            Продолжить
          </button>
        </div>
      </div>
    </div>
  );
};
