import { Holding, Report } from './report';

function fmtUsd(v: number | null): string {
  if (v == null) return 'n/a';
  if (v >= 1000) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `$${v.toFixed(2)}`;
}

function fmtPct(v: number | null): string {
  if (v == null) return 'n/a';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function holdingLine(h: Holding): string {
  const alloc = h.allocationPct == null ? '' : ` (${h.allocationPct.toFixed(1)}%)`;
  return `• ${h.symbol}: ${h.amount} → ${fmtUsd(h.usdValue)}${alloc} [24h ${fmtPct(h.change24h)}]`;
}

export function formatReportText(r: Report): string {
  const lines: string[] = [
    `Portfolio report for ${r.wallet}`,
    `Total: ${fmtUsd(r.totalUsd)}  |  24h: ${fmtPct(r.change24h)}`,
    `Holdings (${r.pricedCount} priced, ${r.unpricedCount} unpriced):`,
  ];
  if (r.holdings.length === 0) lines.push('(empty wallet)');
  for (const h of r.holdings) lines.push(holdingLine(h));

  if (r.positions) {
    lines.push(`On-chain positions (${r.positions.length}):`);
    for (const p of r.positions) {
      lines.push(`• ${p.protocol} ${p.market} [${p.kind}]: ${p.detail}`);
    }
  } else {
    lines.push('On-chain positions: unavailable');
  }

  lines.push(`Active guard rules: ${r.activeRules.length}`);
  for (const rule of r.activeRules) {
    lines.push(`• ${rule.kind} on ${rule.asset}`);
  }
  if (r.unprotected.length > 0) {
    lines.push(`Unprotected (≥$10, no rule): ${r.unprotected.join(', ')}`);
  } else {
    lines.push('Unprotected: none');
  }
  lines.push(`Generated ${r.generatedAt} · PnL since tracking started`);
  return lines.join('\n');
}
