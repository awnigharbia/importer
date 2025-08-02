import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { getImportQueue } from '../queues/importQueue';

export function createDashboard() {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/dashboard');

  const importQueue = getImportQueue();

  createBullBoard({
    queues: [new BullMQAdapter(importQueue)],
    serverAdapter,
  });

  return serverAdapter;
}