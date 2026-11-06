// Guard evaluator + executor entry points. (BullMQ priority queue lands with
// scale-up; the MVP runs an in-process interval loop.)
export const GUARD_QUEUE_NAME = 'sentinel-guard';

export * from './evaluator';
export * from './loop';
