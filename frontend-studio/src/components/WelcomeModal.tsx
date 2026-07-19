import React from 'react';

export interface WelcomeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// Shown exactly once per user, right after their first-ever finalized result
// is on screen — gated by is_first_finalize from the backend (App.tsx). Price
// is deliberately never mentioned anywhere before this: PlanPanel's Finalize
// button, the confirm screen (FinalizeGateModal) — the user sees the real
// value first, the cost only afterward, framed as a gift already spent.
export const WelcomeModal: React.FC<WelcomeModalProps> = ({ isOpen, onClose }) => (
  <div className={`modal ${isOpen ? 'on' : ''}`}>
    <div className="modal-box">
      <h2>Эта финализация — наш подарок</h2>
      <p>
        Мы списали приветственный Trip Credit, который вы получили при регистрации — эта поездка
        досталась вам бесплатно. Следующие финализации — 1 Trip Credit каждая.
      </p>
      <button className="auth-btn" onClick={onClose}>
        Понятно
      </button>
    </div>
  </div>
);
