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
  // First-ever finalize for this user (from GET /credits, fetched alongside
  // the balance check that decides paywall vs confirm — see App.tsx's
  // openFinalizeGate, so this is already known BEFORE the confirm screen
  // renders, not just after the job completes). The gift framing lives here:
  // no credit/price language until the welcome modal reveals it, after the
  // result. Money mechanics are unaffected either way — the welcome credit
  // is still spent normally on the backend; this only changes what's shown.
  isFirstFinalize: boolean;
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
  isFirstFinalize,
  submitting,
  error,
  onConfirm,
  onClose,
}) => {
  const routeSummary = (
    <>
      {originName || '...'} → {destName || '...'} · {stopCount}{' '}
      {stopCount === 1 ? 'остановка' : stopCount < 5 ? 'остановки' : 'остановок'}
      {plannedDays != null ? ` · ${plannedDays}${flexibleDays ? ' ±1' : ''} дн.` : ''}
    </>
  );

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
        ) : isFirstFinalize ? (
          <>
            <h2>Финализировать поездку</h2>
            <p>
              {routeSummary}
              <br /><br />
              В финальную версию войдут: точное время маршрута от Google, разбивка по дням,
              AI-гид по остановкам с учётом дат. Черновик останется доступен — финал не
              заменяет его, а сохраняется отдельно.
            </p>
            {error && (
              <p className="text-[11px] text-[#c05640] mb-3 -mt-2">{error}</p>
            )}
            <button className="auth-btn" onClick={onConfirm} disabled={submitting}>
              {submitting ? 'Финализируем…' : 'Финализировать'}
            </button>
            <button className="auth-btn alt mt-2" onClick={onClose} disabled={submitting}>
              Отмена
            </button>
          </>
        ) : (
          <>
            <h2>Финализировать поездку</h2>
            <p>
              {routeSummary}
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
