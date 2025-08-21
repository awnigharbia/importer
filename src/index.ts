import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import 'express-async-errors';
import path from 'path';

import { env } from './config/env';
import { initSentry, Sentry } from './config/sentry';
import { closeRedis } from './config/redis';
import { logger } from './utils/logger';
import { errorHandler, notFoundHandler } from './api/middleware/errorHandler';
import { dashboardAuthMiddleware } from './api/middleware/dashboardAuth';
import { startImportWorker, closeImportQueue } from './queues/importQueue';
import { createDashboard } from './web/dashboard';
import { getJobRecoveryService } from './services/jobRecovery';
import { getMemoryMonitor } from './utils/memoryMonitor';

// Import routes
import importRoutes from './api/routes/import';
import jobsRoutes from './api/routes/jobs';
import tusRoutes from './api/routes/tus';
import authRoutes from './api/routes/auth';

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
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'importer',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API Routes
app.use('/api', authRoutes);
app.use('/api', importRoutes);
app.use('/api', jobsRoutes);
app.use(env.TUS_PATH, tusRoutes);

// Bull Board Dashboard (protected)
const dashboardAdapter = createDashboard();
app.use('/dashboard', dashboardAuthMiddleware, dashboardAdapter.getRouter() as express.RequestHandler);

// Root route
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web/public/index.html'));
});

// Login page
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web/public/login.html'));
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

// Initialize job recovery service
const jobRecoveryService = getJobRecoveryService();
jobRecoveryService.initialize().catch((error) => {
  logger.error('Failed to initialize job recovery service', { error });
});

// Initialize memory monitoring
const memoryMonitor = getMemoryMonitor();
memoryMonitor.startMonitoring();

// Start background workers
startImportWorker();

// Setup periodic cleanup
setInterval(async () => {
  try {
    await jobRecoveryService.cleanupOldStates();
  } catch (error) {
    logger.error('Failed to cleanup old job states', { error });
  }
}, 6 * 60 * 60 * 1000); // Every 6 hours

// Graceful shutdown
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`${signal} received, starting graceful shutdown`);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  try {
    // Stop memory monitoring
    memoryMonitor.stopMonitoring();

    // Shutdown job recovery service (saves active job states)
    await jobRecoveryService.shutdown();

    // Close queue connections
    await closeImportQueue();

    // Close Redis connection
    await closeRedis();

    logger.info('Graceful shutdown completed');
    // process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown', {
      error: error instanceof Error ? error.message : String(error),
    });
    // process.exit(1);
  }
}

// Handle shutdown signals
// process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  Sentry.captureException(error);
  // process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
  Sentry.captureException(reason);
  // process.exit(1);
});

export default app;