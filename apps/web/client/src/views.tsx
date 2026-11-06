import { useEffect, useState, type JSX } from 'react';
import { api, shortAddr, usd, type Holding, type ProposalItem, type RuleItem } from './api';
import { confirmDialog, haptic } from './tg';

function useLoad<T>(fn: () => Promise<T>): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then(
      (d) => live && (setData(d), setError(null)),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [nonce]);
  return { data, error, reload: () => setNonce((n) => n + 1) };
}

function Loading(): JSX.Element {
  return <div className="muted pad">Loading…</div>;
}

function Err({ error, reload }: { error: string; reload: () => void }): JSX.Element {
  return (
    <div className="pad">
      <div className="error">{error}</div>
      <button className="btn" onClick={reload}>Retry</button>
    </div>
  );
}

function Sparkline({ points }: { points: Array<{ day: string; totalUsd: number }> }): JSX.Element | null {
  if (points.length < 2) return null;
  const vals = points.map((p) => p.totalUsd);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const coords = vals.map((v, i) => `${((i / (vals.length - 1)) * 100).toFixed(1)},${(26 - ((v - min) / span) * 24).toFixed(1)}`);
  return (
    <svg className="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden>
      <polyline points={coords.join(' ')} fill="none" stroke="var(--tg-theme-button-color, #2481cc)" strokeWidth="1.5" />
    </svg>
  );
}

export function PortfolioView({ notify }: { notify: (msg: string) => void }): JSX.Element {
  const { data, error, reload } = useLoad(async () => ({
    pf: await api.portfolio(),
    hist: await api.history(),
  }));
  if (error) return <Err error={error} reload={reload} />;
  if (!data) return <Loading />;
  if (data.pf.wallets.length === 0) {
    return <div className="muted pad">No wallets yet — track one in chat to begin.</div>;
  }
  void notify;
  return (
    <div>
      <div className="total">
        <div className="total-label">Total value</div>
        <div className="total-value">{usd(data.pf.totalUsd)}</div>
        <Sparkline points={data.hist.points} />
      </div>
      {data.pf.wallets.map((w) => (
        <div className="section" key={`${w.chain}:${w.address}`}>
          <div className="section-title">
            {shortAddr(w.address)} <span className="muted">{w.chain}</span>
          </div>
          {w.error ? (
            <div className="error">{w.error}</div>
          ) : (
            w.report && (
              <div>
                {w.report.holdings.map((h: Holding) => (
                  <div className="row" key={h.mint}>
                    <div>
                      <div className="row-main">{h.symbol}</div>
                      <div className="muted small">
                        {h.amount} {h.allocationPct != null ? `· ${h.allocationPct.toFixed(1)}%` : ''}
                      </div>
                    </div>
                    <div className="row-right">
                      <div className="row-main">{usd(h.usdValue)}</div>
                      {h.change24h != null && (
                        <div className={`small ${h.change24h >= 0 ? 'up' : 'down'}`}>
                          {h.change24h >= 0 ? '+' : ''}{h.change24h.toFixed(1)}%
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {w.report.unprotected.length > 0 && (
                  <div className="warn">Unprotected: {w.report.unprotected.map(shortAddr).join(', ')}</div>
                )}
              </div>
            )
          )}
        </div>
      ))}
    </div>
  );
}

export function PositionsView(): JSX.Element {
  const { data, error, reload } = useLoad(api.positions);
  if (error) return <Err error={error} reload={reload} />;
  if (!data) return <Loading />;
  const wallets = data.wallets.filter((w) => w.tracked.length > 0 || (Array.isArray(w.onchain) && w.onchain.length > 0));
  if (wallets.length === 0) return <div className="muted pad">No open positions.</div>;
  return (
    <div>
      {wallets.map((w) => (
        <div className="section" key={`${w.chain}:${w.address}`}>
          <div className="section-title">
            {shortAddr(w.address)} <span className="muted">{w.chain}</span>
          </div>
          {w.tracked.map((p) => (
            <div className="row" key={p.id}>
              <div>
                <div className="row-main">{p.market}</div>
                <div className="muted small">{p.venue} · {p.side ?? '?'} · opened {new Date(p.opened_at).toLocaleDateString()}</div>
              </div>
              <div className="row-right muted small">{p.size ?? ''}</div>
            </div>
          ))}
          {Array.isArray(w.onchain) &&
            w.onchain.map((p, i) => (
              <div className="row" key={`${p.protocol}-${p.market}-${i}`}>
                <div>
                  <div className="row-main">{p.market}</div>
                  <div className="muted small">{p.protocol} · {p.kind} · {p.detail}</div>
                </div>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

function ruleLabel(r: RuleItem): string {
  const p = r.params as Record<string, number>;
  if (r.kind === 'price_drop') return `Price drop ${p.threshold_pct ?? '?'}%`;
  if (r.kind === 'trailing_stop') return `Trailing stop ${p.width_pct ?? '?'}%`;
  if (r.kind === 'liq_distance') return `Liq distance ${p.distance_pct ?? '?'}%`;
  return r.kind;
}

export function RulesView({ notify }: { notify: (msg: string) => void }): JSX.Element {
  const { data, error, reload } = useLoad(api.rules);
  if (error) return <Err error={error} reload={reload} />;
  if (!data) return <Loading />;
  const wallets = data.wallets.filter((w) => w.rules.length > 0);
  if (wallets.length === 0) return <div className="muted pad">No guard rules — say “protect &lt;TOKEN&gt;” in chat.</div>;
  const toggle = async (r: RuleItem) => {
    try {
      const res = r.status === 'active' ? await api.pauseRule(r.id) : await api.resumeRule(r.id);
      haptic('tap');
      notify(`Rule ${res.status}`);
      reload();
    } catch (e) {
      haptic('error');
      notify((e as Error).message);
    }
  };
  return (
    <div>
      {wallets.map((w) => (
        <div className="section" key={`${w.chain}:${w.address}`}>
          <div className="section-title">
            {shortAddr(w.address)} <span className="muted">{w.chain}</span>
          </div>
          {w.rules.map((r) => (
            <div className="row" key={r.id}>
              <div>
                <div className="row-main">{ruleLabel(r)}</div>
                <div className="muted small">{shortAddr(r.asset)} · {r.status}</div>
              </div>
              {(r.status === 'active' || r.status === 'paused') && (
                <button className="btn small" onClick={() => void toggle(r)}>
                  {r.status === 'active' ? 'Pause' : 'Resume'}
                </button>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function proposalSummary(p: ProposalItem): string {
  const pl = p.payload as Record<string, string | number | undefined>;
  if (p.kind === 'swap' && typeof pl.inputMint === 'string' && typeof pl.outputMint === 'string') {
    return `${shortAddr(pl.inputMint)} → ${shortAddr(pl.outputMint)}${typeof pl.usdValue === 'number' ? ` · $${pl.usdValue}` : ''}`;
  }
  if (p.kind === 'withdrawal' && typeof pl.mint === 'string' && typeof pl.toAddress === 'string') {
    return `${shortAddr(pl.mint)} → ${shortAddr(pl.toAddress)}${typeof pl.usdValue === 'number' ? ` · $${pl.usdValue}` : ''}`;
  }
  return p.kind;
}

export function ProposalsView({ notify }: { notify: (msg: string) => void }): JSX.Element {
  const { data, error, reload } = useLoad(api.proposals);
  if (error) return <Err error={error} reload={reload} />;
  if (!data) return <Loading />;
  if (data.proposals.length === 0) return <div className="muted pad">No proposals.</div>;
  const act = async (p: ProposalItem, verb: 'approve' | 'reject') => {
    if (verb === 'approve' && !(await confirmDialog(`Approve this ${p.kind}? It will execute on-chain.`))) return;
    try {
      const res = verb === 'approve' ? await api.approve(p.id) : await api.reject(p.id);
      haptic(res.alert ? 'error' : 'success');
      notify(res.text);
      reload();
    } catch (e) {
      haptic('error');
      notify((e as Error).message);
    }
  };
  return (
    <div>
      {data.proposals.map((p) => (
        <div className="section" key={p.id}>
          <div className="row-main">{proposalSummary(p)}</div>
          <div className="muted small">
            {p.status} · expires {new Date(p.expiresAt).toLocaleString()}
          </div>
          {p.status === 'pending' && (
            <div className="btn-row">
              <button className="btn primary" onClick={() => void act(p, 'approve')}>Approve</button>
              <button className="btn danger" onClick={() => void act(p, 'reject')}>Reject</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function countdown(runAt: string): string {
  const ms = new Date(runAt).getTime() - Date.now();
  if (ms <= 0) return 'due now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function kindLabel(kind: string): string {
  if (kind === 'balance_check') return 'Balance check';
  if (kind === 'research') return 'Research brief';
  return 'Reminder';
}

export function SchedulesView({ notify }: { notify: (msg: string) => void }): JSX.Element {
  const { data, error, reload } = useLoad(api.scheduled);
  if (error) return <Err error={error} reload={reload} />;
  if (!data) return <Loading />;
  if (data.actions.length === 0) {
    return <div className="muted pad">Nothing scheduled — say “remind me in 3 hours” or “check my deposit in 30 minutes” in chat.</div>;
  }
  const cancel = async (id: string) => {
    try {
      await api.cancelScheduled(id);
      haptic('tap');
      notify('Schedule cancelled');
      reload();
    } catch (e) {
      haptic('error');
      notify((e as Error).message);
    }
  };
  return (
    <div className="section">
      {data.actions.map((a) => (
        <div className="row" key={a.id}>
          <div>
            <div className="row-main">{kindLabel(a.kind)}</div>
            <div className="muted small">
              {a.message} · {a.status === 'pending' ? countdown(a.runAt) : a.status}
            </div>
          </div>
          {a.status === 'pending' && (
            <button className="btn small" onClick={() => void cancel(a.id)}>Cancel</button>
          )}
        </div>
      ))}
    </div>
  );
}

export function ActivityView(): JSX.Element {
  const { data, error, reload } = useLoad(api.activity);
  if (error) return <Err error={error} reload={reload} />;
  if (!data) return <Loading />;
  if (data.events.length === 0) return <div className="muted pad">No activity recorded yet.</div>;
  return (
    <div className="section">
      {data.events.map((e, i) => (
        <div className="row" key={i}>
          <div>
            <div className="row-main">{e.action}</div>
            <div className="muted small">{e.actor} · {new Date(e.at).toLocaleString()}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
