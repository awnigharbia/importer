import { Queue, Job } from 'bullmq';
import { getRedisClient } from '../config/redis';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import fs from 'fs';
import path from 'path';

export interface JobState {
  jobId: string;
  status: 'active' | 'stalled' | 'failed' | 'completed';
  data: any;
  progress?: any;
  tempFiles?: string[];
  timestamp: number;
}

export class JobRecoveryService {
  private static readonly RECOVERY_KEY = 'job_recovery_state';
  private static readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private static readonly STALE_JOB_THRESHOLD = 300000; // 5 minutes
  
  private redis;
  private heartbeatInterval?: NodeJS.Timeout;
  private activeJobs = new Map<string, JobState>();

  constructor() {
    this.redis = getRedisClient();
  }

  async initialize(): Promise<void> {
    logger.info('Initializing job recovery service');
    
    // Start heartbeat to track active jobs
    this.startHeartbeat();
    
    // Recover any stalled jobs from previous session
    await this.recoverStalledJobs();
  }

  async trackJob(job: Job, tempFiles: string[] = []): Promise<void> {
    const jobState: JobState = {
      jobId: job.id!,
      status: 'active',
      data: job.data,
      progress: await job.getProgress(),
      tempFiles,
      timestamp: Date.now(),
    };

    this.activeJobs.set(job.id!, jobState);
    await this.persistJobState(jobState);
    
    logger.debug('Job tracked for recovery', { jobId: job.id });
  }

  async updateJobProgress(jobId: string, progress: any, tempFiles?: string[]): Promise<void> {
    const jobState = this.activeJobs.get(jobId);
    if (jobState) {
      jobState.progress = progress;
      jobState.timestamp = Date.now();
      
      if (tempFiles) {
        jobState.tempFiles = tempFiles;
      }
      
      await this.persistJobState(jobState);
    }
  }

  async completeJob(jobId: string): Promise<void> {
    const jobState = this.activeJobs.get(jobId);
    if (jobState) {
      jobState.status = 'completed';
      jobState.timestamp = Date.now();
      
      // Clean up temp files
      await this.cleanupTempFiles(jobState.tempFiles || []);
      
      // Remove from active tracking
      this.activeJobs.delete(jobId);
      await this.removeJobState(jobId);
      
      logger.debug('Job completed and cleaned up', { jobId });
    }
  }

  async failJob(jobId: string, error: Error): Promise<void> {
    const jobState = this.activeJobs.get(jobId);
    if (jobState) {
      jobState.status = 'failed';
      jobState.timestamp = Date.now();
      
      // Clean up temp files
      await this.cleanupTempFiles(jobState.tempFiles || []);
      
      // Keep failed job state for a while for debugging
      await this.persistJobState(jobState);
      this.activeJobs.delete(jobId);
      
      logger.warn('Job failed and cleaned up', { jobId, error: error.message });
    }
  }

  private async recoverStalledJobs(): Promise<void> {
    try {
      const stalledJobStates = await this.getStalledJobStates();
      
      if (stalledJobStates.length === 0) {
        logger.info('No stalled jobs found to recover');
        return;
      }

      logger.info(`Found ${stalledJobStates.length} stalled jobs to recover`);

      for (const jobState of stalledJobStates) {
        await this.recoverJob(jobState);
      }
    } catch (error) {
      logger.error('Failed to recover stalled jobs', { 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }

  private async recoverJob(jobState: JobState): Promise<void> {
    try {
      const queue = new Queue('import', { connection: this.redis });
      const job = await queue.getJob(jobState.jobId);

      if (!job) {
        logger.warn('Job not found in queue, cleaning up state', { jobId: jobState.jobId });
        await this.cleanupTempFiles(jobState.tempFiles || []);
        await this.removeJobState(jobState.jobId);
        return;
      }

      const jobStatus = await job.getState();
      
      if (jobStatus === 'completed') {
        logger.info('Job already completed, cleaning up state', { jobId: jobState.jobId });
        await this.cleanupTempFiles(jobState.tempFiles || []);
        await this.removeJobState(jobState.jobId);
        return;
      }

      if (jobStatus === 'active' || jobStatus === 'waiting') {
        logger.info('Job is still in queue, no recovery needed', { jobId: jobState.jobId });
        return;
      }

      // Clean up any temp files from interrupted job
      await this.cleanupTempFiles(jobState.tempFiles || []);

      // Retry the job
      if (jobStatus === 'failed' || jobStatus === 'stalled') {
        logger.info('Retrying stalled/failed job', { jobId: jobState.jobId });
        await job.retry();
      }

      // Remove old state
      await this.removeJobState(jobState.jobId);
      
    } catch (error) {
      logger.error('Failed to recover individual job', {
        jobId: jobState.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      
      // Clean up temp files even if recovery fails
      await this.cleanupTempFiles(jobState.tempFiles || []);
      await this.removeJobState(jobState.jobId);
    }
  }

  private async getStalledJobStates(): Promise<JobState[]> {
    const stateKeys = await this.redis.keys(`${JobRecoveryService.RECOVERY_KEY}:*`);
    const stalledJobs: JobState[] = [];
    const staleThreshold = Date.now() - JobRecoveryService.STALE_JOB_THRESHOLD;

    for (const key of stateKeys) {
      try {
        const stateData = await this.redis.get(key);
        if (stateData) {
          const jobState: JobState = JSON.parse(stateData);
          
          // Consider job stalled if it's older than threshold and was active
          if (jobState.timestamp < staleThreshold && jobState.status === 'active') {
            stalledJobs.push(jobState);
          }
        }
      } catch (error) {
        logger.warn('Failed to parse job state', { key, error });
        // Remove corrupted state
        await this.redis.del(key);
      }
    }

    return stalledJobs;
  }

  private async persistJobState(jobState: JobState): Promise<void> {
    const key = `${JobRecoveryService.RECOVERY_KEY}:${jobState.jobId}`;
    await this.redis.setex(key, 3600, JSON.stringify(jobState)); // 1 hour TTL
  }

  private async removeJobState(jobId: string): Promise<void> {
    const key = `${JobRecoveryService.RECOVERY_KEY}:${jobId}`;
    await this.redis.del(key);
  }

  private async cleanupTempFiles(tempFiles: string[]): Promise<void> {
    for (const filePath of tempFiles) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          logger.debug('Cleaned up temp file', { filePath });
        }
      } catch (error) {
        logger.warn('Failed to cleanup temp file', { 
          filePath, 
          error: error instanceof Error ? error.message : String(error) 
        });
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      try {
        // Update timestamp for all active jobs
        for (const [jobId, jobState] of this.activeJobs.entries()) {
          jobState.timestamp = Date.now();
          await this.persistJobState(jobState);
        }
      } catch (error) {
        logger.error('Heartbeat failed', { 
          error: error instanceof Error ? error.message : String(error) 
        });
      }
    }, JobRecoveryService.HEARTBEAT_INTERVAL);
  }

  async shutdown(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Mark all active jobs as stalled for recovery on next startup
    for (const [jobId, jobState] of this.activeJobs.entries()) {
      jobState.status = 'stalled';
      jobState.timestamp = Date.now();
      await this.persistJobState(jobState);
    }

    logger.info('Job recovery service shutdown complete');
  }

  // Clean up old recovery states periodically
  async cleanupOldStates(): Promise<void> {
    try {
      const stateKeys = await this.redis.keys(`${JobRecoveryService.RECOVERY_KEY}:*`);
      const oldThreshold = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
      let cleanedCount = 0;

      for (const key of stateKeys) {
        try {
          const stateData = await this.redis.get(key);
          if (stateData) {
            const jobState: JobState = JSON.parse(stateData);
            
            if (jobState.timestamp < oldThreshold) {
              await this.redis.del(key);
              await this.cleanupTempFiles(jobState.tempFiles || []);
              cleanedCount++;
            }
          }
        } catch (error) {
          // Remove corrupted state
          await this.redis.del(key);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} old job recovery states`);
      }
    } catch (error) {
      logger.error('Failed to cleanup old recovery states', { 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }
}

// Singleton instance
let jobRecoveryService: JobRecoveryService | null = null;

export function getJobRecoveryService(): JobRecoveryService {
  if (!jobRecoveryService) {
    jobRecoveryService = new JobRecoveryService();
  }
  return jobRecoveryService;
}