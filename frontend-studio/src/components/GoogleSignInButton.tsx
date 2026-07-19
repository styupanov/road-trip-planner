import React, { useEffect, useRef, useState } from 'react';

// Minimal shape of the Google Identity Services (GIS) global — only what
// this component actually calls. GIS attaches itself to window once its
// script has loaded, there's no importable module for it.
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

// Module-level, not component state: the script tag (and GIS's own global
// init) only needs to happen once for the whole page, even if this component
// were ever mounted twice. Reused across mounts/remounts of this component.
let gisScriptPromise: Promise<void> | null = null;

function loadGisScript(): Promise<void> {
  if (gisScriptPromise) return gisScriptPromise;

  gisScriptPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity Services')));
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(script);
  });

  return gisScriptPromise;
}

export interface GoogleSignInButtonProps {
  // Called with the raw ID token (JWT) — the caller is the one that actually
  // POSTs it to /auth/google; this component never talks to our backend.
  onCredential: (credential: string) => void;
}

export const GoogleSignInButton: React.FC<GoogleSignInButtonProps> = ({ onCredential }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Ref, not a dependency: renderButton's callback is registered once with
  // GIS below and must always call the LATEST onCredential, not whatever
  // closure existed the moment the button was rendered — the caller
  // (App.tsx) passes a new inline function on every render.
  const onCredentialRef = useRef(onCredential);
  onCredentialRef.current = onCredential;

  useEffect(() => {
    const clientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '';
    if (!clientId) {
      setError('Вход через Google не настроен.');
      return;
    }

    let cancelled = false;

    loadGisScript()
      .then(() => {
        if (cancelled || !window.google || !containerRef.current) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => onCredentialRef.current(response.credential),
        });
        window.google.accounts.id.renderButton(containerRef.current, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          width: 280,
        });
      })
      .catch(() => {
        if (!cancelled) setError('Не удалось загрузить вход через Google.');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="text-[11px] text-[#c05640] text-center">{error}</p>;
  }

  return <div ref={containerRef} className="flex justify-center" />;
};
