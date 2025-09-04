import { Router } from 'express';
import { z } from 'zod';
import { 
  getImportQueue, 
  retryImportJob, 
  killActiveJob,
  obliterateQueue,
  drainQueue,
  pauseQueue,
  resumeQueue
} from '../../queues/importQueue';
import { AppError } from '../middleware/errorHandler';

const router = Router();

const paginationSchema = z.object({
  page: z.string().optional().default('1').transform(Number),
  limit: z.string().optional().default('20').transform(Number),
  status: z.enum(['completed', 'failed', 'active', 'waiting', 'delayed']).optional(),
});

// List all jobs with pagination
router.get('/jobs', async (req, res, next) => {
  try {
    const validation = paginationSchema.safeParse(req.query);
    
    if (!validation.success) {
      throw validation.error;
    }

    const { page, limit, status } = validation.data;
    const queue = getImportQueue();

    const start = (page - 1) * limit;
    const end = start + limit - 1;

    let jobs;
    if (status) {
      jobs = await queue.getJobs([status], start, end, true); // true for descending order
    } else {
      jobs = await queue.getJobs(
        ['completed', 'failed', 'active', 'waiting', 'delayed'],
        start,
        end,
        true // true for descending order (newest first)
      );
    }

    const jobCount = await queue.getJobCounts();
    const totalJobs = Object.values(jobCount).reduce((sum, count) => sum + count, 0);

    const jobData = await Promise.all(
      jobs.map(async (job) => {
        const state = await job.getState();
        // Get proxy logs from either progress or return value
        let proxyLogs = undefined;
        if (typeof job.progress === 'object' && job.progress && 'proxyLogs' in job.progress) {
          proxyLogs = (job.progress as any).proxyLogs;
        } else if (job.returnvalue?.proxyLogs) {
          proxyLogs = job.returnvalue.proxyLogs;
        }
        
        // Get selected quality from progress or return value (for YouTube downloads)
        let selectedQuality = undefined;
        if (job.returnvalue?.selectedQuality) {
          selectedQuality = job.returnvalue.selectedQuality;
        } else if (typeof job.progress === 'object' && job.progress && 'selectedQuality' in job.progress) {
          selectedQuality = (job.progress as any).selectedQuality;
        }
        
        return {
          id: job.id,
          data: job.data,
          status: state,
          progress: job.progress,
          returnValue: job.returnvalue,
          failedReason: job.failedReason,
          attemptsMade: job.attemptsMade,
          timestamp: job.timestamp,
          processedOn: job.processedOn,
          finishedOn: job.finishedOn,
          proxyLogs,
          selectedQuality,
        };
      })
    );

    res.json({
      success: true,
      data: {
        jobs: jobData,
        pagination: {
          page,
          limit,
          total: totalJobs,
          totalPages: Math.ceil(totalJobs / limit),
        },
        counts: jobCount,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get job details
router.get('/jobs/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const queue = getImportQueue();
    const job = await queue.getJob(id);

    if (!job) {
      throw new AppError('Job not found', 404);
    }

    const state = await job.getState();
    const logs = await queue.getJobLogs(id);
    
    // Get proxy logs from either progress or return value
    let proxyLogs = undefined;
    if (typeof job.progress === 'object' && job.progress && 'proxyLogs' in job.progress) {
      proxyLogs = (job.progress as any).proxyLogs;
    } else if (job.returnvalue?.proxyLogs) {
      proxyLogs = job.returnvalue.proxyLogs;
    }

    // Get selected quality from progress or return value (for YouTube downloads)
    let selectedQuality = undefined;
    if (job.returnvalue?.selectedQuality) {
      selectedQuality = job.returnvalue.selectedQuality;
    } else if (typeof job.progress === 'object' && job.progress && 'selectedQuality' in job.progress) {
      selectedQuality = (job.progress as any).selectedQuality;
    }

    res.json({
      success: true,
      data: {
        id: job.id,
        data: job.data,
        status: state,
        progress: job.progress,
        returnValue: job.returnvalue,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        logs: logs.logs,
        proxyLogs,
        selectedQuality,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Manual retry for failed job
router.post('/jobs/:id/retry', async (req, res, next) => {
  try {
    const { id } = req.params;
    await retryImportJob(id);

    res.json({
      success: true,
      message: 'Job retry requested successfully',
    });
  } catch (error) {
    next(error);
  }
});

// Delete a job
router.delete('/jobs/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const queue = getImportQueue();
    const job = await queue.getJob(id);

    if (!job) {
      throw new AppError('Job not found', 404);
    }

    await job.remove();

    res.json({
      success: true,
      message: 'Job deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

// Kill an active job (forces termination)
router.delete('/jobs/:id/kill', async (req, res, next) => {
  try {
    const { id } = req.params;
    await killActiveJob(id);

    res.json({
      success: true,
      message: 'Job killed successfully',
    });
  } catch (error) {
    next(error);
  }
});

// Queue management endpoints
router.post('/queue/obliterate', async (_req, res, next) => {
  try {
    await obliterateQueue();
    res.json({
      success: true,
      message: 'Queue obliterated - all jobs removed',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/queue/drain', async (_req, res, next) => {
  try {
    await drainQueue();
    res.json({
      success: true,
      message: 'Queue drained - all waiting jobs removed',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/queue/pause', async (_req, res, next) => {
  try {
    await pauseQueue();
    res.json({
      success: true,
      message: 'Queue paused',
    });
  } catch (error) {
    next(error);
  }
});

router.post('/queue/resume', async (_req, res, next) => {
  try {
    await resumeQueue();
    res.json({
      success: true,
      message: 'Queue resumed',
    });
  } catch (error) {
    next(error);
  }
});

export default router;