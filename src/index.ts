import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import 'express-async-errors';
import path from 'path';

import { env } from './config/env';
import { initSentry, Sentry } from './config/sentry';
import { closeRedis } from './config/redis';
import { logger } from './utils/logger';
import { errorHandler, notFoundHandler } from './api/middleware/errorHandler';
import { startImportWorker, closeImportQueue } from './queues/importQueue';
import { createDashboard } from './web/dashboard';

// Import routes
import importRoutes from './api/routes/import';
import jobsRoutes from './api/routes/jobs';
import tusRoutes from './api/routes/tus';

// Initialize Sentry
initSentry();

// Create Express app
const app = express();

// Trust proxy
app.set('trust proxy', 1);

// Middleware
app.use(Sentry.Handlers.requestHandler());
app.use(helmet({
  contentSecurityPolicy: false, // Disable for dashboard
}));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  message: 'Too many requests from this IP, please try again later.',
});

app.use('/api/', limiter);

// Static files
app.use(express.static(path.join(__dirname, 'web/public')));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'importer',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API Routes
app.use('/api', importRoutes);
app.use('/api', jobsRoutes);
app.use(env.TUS_PATH, tusRoutes);

// Bull Board Dashboard
const dashboardAdapter = createDashboard();
app.use('/dashboard', dashboardAdapter.getRouter());

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'web/public/index.html'));
});

// Sentry error handler
app.use(Sentry.Handlers.errorHandler());

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
const server = app.listen(env.PORT, () => {
  logger.info(`Server started on port ${env.PORT}`);
  logger.info(`Environment: ${env.NODE_ENV}`);
  logger.info(`Dashboard available at http://localhost:${env.PORT}/dashboard`);
});

// Start background workers
startImportWorker();

// Graceful shutdown
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, starting graceful shutdown`);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  try {
    // Close queue connections
    await closeImportQueue();
    
    // Close Redis connection
    await closeRedis();

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  Sentry.captureException(error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
  Sentry.captureException(reason);
  process.exit(1);
});

export default app;