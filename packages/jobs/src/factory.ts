import { optional } from '@sentinel/config';
import { BullMqScheduler } from './bullmq';
import { MemoryScheduler } from './memory';
import type { SchedulerDriver } from './types';

/** Memory unless QUEUE_DRIVER=redis is set explicitly (safe where no daemon runs). */
export function createScheduler(): SchedulerDriver {
  return optional('QUEUE_DRIVER', 'memory') === 'redis' ? new BullMqScheduler() : new MemoryScheduler();
}
