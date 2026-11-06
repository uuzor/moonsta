import { useEffect, useState, type JSX } from 'react';
import { api } from './api';
import { boot, haptic, webApp } from './tg';
import { ActivityView, PortfolioView, PositionsView, ProposalsView, RulesView, SchedulesView } from './views';
import './styles.css';

type Tab = 'portfolio' | 'positions' | 'rules' | 'proposals' | 'schedules' | 'activity';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'portfolio', label: 'Wallet' },
  { id: 'positions', label: 'Positions' },
  { id: 'rules', label: 'Guards' },
  { id: 'proposals', label: 'Approvals' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'activity', label: 'Activity' },
];

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('portfolio');
  const [toast, setToast] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    boot();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const notify = (msg: string) => setToast(msg);

  const togglePause = async () => {
    try {
      const res = paused ? await api.resumeAll() : await api.pauseAll();
      setPaused(!paused);
      haptic('tap');
      notify(res.message);
    } catch (e) {
      haptic('error');
      notify((e as Error).message);
    }
  };

  if (!webApp()) {
    return (
      <div className="app">
        <main>
          <div className="pad section">
            <h2 className="section-title">Open me inside Telegram</h2>
            <p>
              This dashboard verifies you through Telegram. Message{' '}
              <a href="https://t.me/Clawbuns_bot">@Clawbuns_bot</a>, send /start,
              then tap Menu → Dashboard.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Moonsta</span>
        <button className={paused ? 'btn small' : 'btn small danger-outline'} onClick={() => void togglePause()}>
          {paused ? 'Resume' : 'Pause all'}
        </button>
      </header>
      <main>
        {tab === 'portfolio' && <PortfolioView notify={notify} />}
        {tab === 'positions' && <PositionsView />}
        {tab === 'rules' && <RulesView notify={notify} />}
        {tab === 'proposals' && <ProposalsView notify={notify} />}
        {tab === 'schedules' && <SchedulesView notify={notify} />}
        {tab === 'activity' && <ActivityView />}
      </main>
      {toast && <div className="toast">{toast}</div>}
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => { setTab(t.id); haptic('tap'); }}>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
