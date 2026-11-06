import { registerJob } from '@sentinel/jobs';
import { DIGEST_JOB_NAME } from '@sentinel/research';

/**
 * Cron slot for the scheduled research digest (trending tokens, funding,
 * news filtered by user interests -> Telegram digest with proposals).
 * Content lands with the digest step in @sentinel/research; this stub proves
 * the daily schedule fires and is monitored. The job name is owned by the
 * research app so the slot and the implementation cannot drift apart.
 */
export function registerDigestJob(): void {
  registerJob({
    name: DIGEST_JOB_NAME,
    description: 'Daily research digest (STUB: content lands with the digest step).',
    cron: '0 8 * * *',
    run: async () => ({ ok: true, summary: 'stub: digest content not yet implemented' }),
  });
}
