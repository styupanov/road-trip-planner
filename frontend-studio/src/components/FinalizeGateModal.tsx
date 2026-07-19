import React from 'react';

export interface FinalizeGateModalProps {
  isOpen: boolean;
  // 'paywall': balance=0, no purchase flow yet (Stripe is out of MVP scope) —
  // this is a dead end with an explanation, not a broken button.
  // 'confirm': balance>=1, summary + the one button that actually spends it.
  stage: 'paywall' | 'confirm' | null;
  originName: string;
  destName: string;
  stopCount: number;
  plannedDays: number | null;
  flexibleDays: boolean;
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export const FinalizeGateModal: React.FC<FinalizeGateModalProps> = ({
  isOpen,
  stage,
  originName,
  destName,
  stopCount,
  plannedDays,
  flexibleDays,
  submitting,
  error,
  onConfirm,
  onClose,
}) => {
  return (
    <div className={`modal ${isOpen ? 'on' : ''}`}>
      <div className="modal-box">
        {stage === 'paywall' ? (
          <>
            <h2>Нужен 1 Trip Credit</h2>
            <p>
              Бесплатный кредит за регистрацию уже использован. Покупка кредитов — скоро.
              Черновик поездки остаётся доступен, вы ничего не теряете.
            </p>
            <button className="auth-btn" disabled title="Покупка кредитов скоро">
              Купить кредит — скоро
            </button>
            <button className="auth-btn alt mt-2" onClick={onClose}>
              Закрыть
            </button>
          </>
        ) : (
          <>
            <h2>Финализировать поездку</h2>
            <p>
              {originName || '...'} → {destName || '...'} · {stopCount}{' '}
              {stopCount === 1 ? 'остановка' : stopCount < 5 ? 'остановки' : 'остановок'}
              {plannedDays != null ? ` · ${plannedDays}${flexibleDays ? ' ±1' : ''} дн.` : ''}
              <br /><br />
              В финальную версию войдут: точное время маршрута от Google, разбивка по дням,
              AI-гид по остановкам с учётом дат. Финализация использует{' '}
              <b>1 Trip Credit</b>. Черновик останется доступен — финал не заменяет его,
              а сохраняется отдельно.
            </p>
            {error && (
              <p className="text-[11px] text-[#c05640] mb-3 -mt-2">{error}</p>
            )}
            <button className="auth-btn" onClick={onConfirm} disabled={submitting}>
              {submitting ? 'Финализируем…' : 'Использовать кредит и финализировать'}
            </button>
            <button className="auth-btn alt mt-2" onClick={onClose} disabled={submitting}>
              Отмена
            </button>
          </>
        )}
      </div>
    </div>
  );
};
