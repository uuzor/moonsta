/** Minimal typed wrapper over window.Telegram.WebApp (no SDK dependency). */

interface WebAppApi {
  initData: string;
  ready(): void;
  expand(): void;
  showConfirm(message: string, callback: (confirmed: boolean) => void): void;
  HapticFeedback: {
    impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: WebAppApi };
  }
}

export function webApp(): WebAppApi | null {
  return window.Telegram?.WebApp ?? null;
}

export function initData(): string {
  return webApp()?.initData ?? '';
}

export function boot(): void {
  const wa = webApp();
  if (!wa) return;
  wa.ready();
  wa.expand();
}

export function haptic(kind: 'tap' | 'success' | 'error'): void {
  const hf = webApp()?.HapticFeedback;
  if (!hf) return;
  try {
    if (kind === 'tap') hf.selectionChanged();
    else hf.notificationOccurred(kind);
  } catch {
    // ignore: host may not support haptics
  }
}

export function confirmDialog(message: string): Promise<boolean> {
  const wa = webApp();
  if (!wa) return Promise.resolve(window.confirm(message));
  return new Promise((resolve) => {
    try {
      wa.showConfirm(message, resolve);
    } catch {
      resolve(window.confirm(message));
    }
  });
}
