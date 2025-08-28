import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { getRedisClient } from '../config/redis';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { processImportJob } from '../jobs/importJob';
import { Sentry } from '../config/sentry';

export interface ImportJobData {
  url: string;
  type: 'gdrive' | 'direct' | 'youtube' | 'local';
  fileName?: string | undefined;
  requestId: string;
  videoId?: string; // For TUS uploads, the pre-created video ID
  tusUploadId?: string; // TUS upload ID for tracking
}

export interface ImportJobResult {
  success: boolean;
  cdnUrl?: string;
  fileName?: string;
  fileSize?: number;
  error?: string;
  retryCount?: number;
}

export interface ImportJobProgress {
  stage: 'downloading' | 'uploading';
  percentage: number;
  message: string;
}

let importQueue: Queue<ImportJobData, ImportJobResult> | null = null;
let importWorker: Worker<ImportJobData, ImportJobResult> | null = null;
let queueEvents: QueueEvents | null = null;

export function getImportQueue(): Queue<ImportJobData, ImportJobResult> {
  if (!importQueue) {
    const connection = getRedisClient();

    importQueue = new Queue<ImportJobData, ImportJobResult>('import', {
      connection,
      defaultJobOptions: {
        attempts: env.MAX_RETRY_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: 5000, // Increased initial delay
        },
        removeOnComplete: {
          age: 24 * 3600, // 24 hours
          count: 100,
        },
        removeOnFail: {
          age: 7 * 24 * 3600, // 7 days
        },
      },
    });

    importQueue.on('error', (error) => {
      logger.error('Import queue error', { error: error.message });
      Sentry.captureException(error);
    });
  }

  return importQueue;
}

export function startImportWorker(): Worker<ImportJobData, ImportJobResult> {
  if (!importWorker) {
    const connection = getRedisClient();

    importWorker = new Worker<ImportJobData, ImportJobResult>(
      'import',
      async (job: Job<ImportJobData>) => {
        logger.info('Processing import job', {
          jobId: job.id,
          data: job.data,
          attemptsMade: job.attemptsMade,
        });

        try {
          const result = await processImportJob(job);
          return result;
        } catch (error) {
          logger.error('Import job failed', {
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error),
            attemptsMade: job.attemptsMade,
            maxAttempts: job.opts.attempts,
          });

          Sentry.captureException(error, {
            tags: {
              jobId: job.id,
              jobType: 'import',
              attemptsMade: job.attemptsMade,
            },
            extra: {
              url: job.data.url,
              type: job.data.type,
              requestId: job.data.requestId,
            },
          });

          // For certain types of errors, don't retry
          if (error instanceof Error) {
            const nonRetryableErrors = [
              'File not found',
              'Invalid Google Drive URL',
              'File is not a video',
              'access denied',
              'unauthorized',
            ];

            const shouldNotRetry = nonRetryableErrors.some(pattern =>
              error.message.toLowerCase().includes(pattern.toLowerCase())
            );

            if (shouldNotRetry) {
              logger.info('Job failed with non-retryable error, not retrying', {
                jobId: job.id,
                error: error.message,
              });

              // Mark job as failed permanently by throwing a specific error
              const permanentError = new Error(`Permanent failure: ${error.message}`);
              (permanentError as any).name = 'PermanentFailure';
              throw permanentError;
            }
          }

          throw error;
        }
      },
      {
        connection,
        concurrency: 5, // Single job for 10GB+ files on 4GB server
        maxStalledCount: 5, // Increased for better recovery
        stalledInterval: 60000, // Longer stall check for large files
        lockDuration: env.JOB_TIMEOUT_MS,
      }
    );

    importWorker.on('completed', (job) => {
      logger.info('Import job completed', {
        jobId: job.id,
        returnValue: job.returnvalue,
      });
    });

    importWorker.on('failed', (job, err) => {
      logger.error('Import job failed', {
        jobId: job?.id,
        error: err.message,
        attemptsMade: job?.attemptsMade,
      });
    });

    importWorker.on('stalled', (jobId) => {
      logger.warn('Import job stalled', { jobId });
    });

    importWorker.on('error', (err) => {
      logger.error('Import worker error', { error: err.message });
      Sentry.captureException(err);
    });
  }

  return importWorker;
}

export function getQueueEvents(): QueueEvents {
  if (!queueEvents) {
    const connection = getRedisClient();
    queueEvents = new QueueEvents('import', { connection });
  }
  return queueEvents;
}

export async function addImportJob(data: ImportJobData): Promise<Job<ImportJobData, ImportJobResult>> {
  const queue = getImportQueue();
  const job = await queue.add('import', data, {
    jobId: data.requestId,
  });

  logger.info('Import job added', {
    jobId: job.id,
    data: job.data,
  });

  return job;
}

export async function retryImportJob(jobId: string): Promise<void> {
  const queue = getImportQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  if (await job.isCompleted()) {
    throw new Error(`Job ${jobId} is already completed`);
  }

  if (await job.isActive()) {
    throw new Error(`Job ${jobId} is currently active`);
  }

  await job.retry();
  logger.info('Import job retry requested', { jobId });
}

export async function killActiveJob(jobId: string): Promise<void> {
  const queue = getImportQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  if (await job.isActive()) {
    await job.moveToFailed(new Error('Job manually killed'), '0');
    logger.info('Active job killed', { jobId });
  } else {
    await job.remove();
    logger.info('Non-active job deleted', { jobId });
  }
}

export async function obliterateQueue(): Promise<void> {
  const queue = getImportQueue();
  await queue.obliterate({ force: true });
  logger.info('Queue obliterated - all jobs removed');
}

export async function drainQueue(): Promise<void> {
  const queue = getImportQueue();
  await queue.drain();
  logger.info('Queue drained - all waiting jobs removed');
}

export async function pauseQueue(): Promise<void> {
  const queue = getImportQueue();
  await queue.pause();
  logger.info('Queue paused');
}

export async function resumeQueue(): Promise<void> {
  const queue = getImportQueue();
  await queue.resume();
  logger.info('Queue resumed');
}

export async function closeImportQueue(): Promise<void> {
  if (importWorker) {
    await importWorker.close();
    importWorker = null;
  }

  if (importQueue) {
    await importQueue.close();
    importQueue = null;
  }

  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }

  logger.info('Import queue closed');
}