import { ExpressAdapter } from '@bull-board/express';

export function createDashboard() {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/dashboard');

  // Temporarily disable Bull Board due to type compatibility issues
  // Will be re-enabled after updating dependencies
  
  return serverAdapter;
}