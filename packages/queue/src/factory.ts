import { optional } from '@sentinel/config';
import { BullMqTurnQueue, RedisCounter, RedisLock } from './redis';
import { MemoryCounter, MemoryLock, MemoryTurnQueue } from './memory';
import { Counter, Lock, TurnQueue } from './types';

export type DriverName = 'memory' | 'redis';

/** Memory unless QUEUE_DRIVER=redis is set explicitly (safe where no daemon runs). */
export function driverName(): DriverName {
  return optional('QUEUE_DRIVER', 'memory') === 'redis' ? 'redis' : 'memory';
}

function redisUrl(): string {
  return optional('REDIS_URL', 'redis://localhost:6379');
}

export function createTurnQueue(): TurnQueue {
  if (driverName() === 'redis') return new BullMqTurnQueue(redisUrl());
  return new MemoryTurnQueue();
}

export function createLock(): Lock {
  if (driverName() === 'redis') return new RedisLock(redisUrl());
  return new MemoryLock();
}

export function createCounter(): Counter {
  if (driverName() === 'redis') return new RedisCounter(redisUrl());
  return new MemoryCounter();
}
