import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
// import { BullMQAdapter } from '@bull-board/api/dist/src/queueAdapters/bullMQ';
// import { getImportQueue } from '../queues/importQueue';

export function createDashboard() {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/dashboard');

  // Temporarily disable queue integration due to type compatibility issues
  // The dashboard will show a basic interface without queue monitoring
  
  createBullBoard({
    queues: [],
    serverAdapter: serverAdapter,
  });
  
  return serverAdapter;
}