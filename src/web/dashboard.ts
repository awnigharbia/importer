import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/dist/src/queueAdapters/bullMQ';

export function createDashboard() {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/dashboard');

  // Create dashboard with empty queues initially
  const bullBoard = createBullBoard({
    queues: [],
    serverAdapter: serverAdapter,
  });

  // Try to add import queue after Redis connection is established
  setTimeout(async () => {
    try {
      const { getImportQueue } = await import('../queues/importQueue');
      const importQueue = getImportQueue();
      
      // Add the queue to the existing dashboard
      bullBoard.addQueue(new BullMQAdapter(importQueue) as any);
      console.log('Import queue added to Bull Board dashboard');
    } catch (error) {
      console.warn('Failed to add import queue to dashboard:', error);
    }
  }, 2000); // Wait 2 seconds for Redis to potentially connect
  
  return serverAdapter;
}