import { Job } from 'bullmq';
import path from 'path';
import { nanoid } from 'nanoid';
import { ImportJobData, ImportJobResult, ImportJobProgress } from '../queues/importQueue';
import { Downloader } from '../services/downloader';
import { GoogleDriveDownloader } from '../services/googleDriveDownloader';
import { BunnyStorage } from '../services/bunnyStorage';
import { ChunkedUploader } from '../services/chunkedUploader';
import { sendTelegramNotification } from '../services/telegram';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { getJobRecoveryService } from '../services/jobRecovery';

export async function processImportJob(
  job: Job<ImportJobData, ImportJobResult>
): Promise<ImportJobResult> {
  const { url, type, fileName } = job.data;
  const downloader = new Downloader();
  const googleDriveDownloader = new GoogleDriveDownloader();
  const bunnyStorage = new BunnyStorage();
  const chunkedUploader = new ChunkedUploader();
  const recoveryService = getJobRecoveryService();

  let downloadResult;
  let tempFilePath: string | null = null;
  let tempFiles: string[] = [];

  try {
    // Track job for recovery
    await recoveryService.trackJob(job, tempFiles);
    // Download stage
    await job.updateProgress({
      stage: 'downloading',
      percentage: 0,
      message: 'Starting download...',
    } as ImportJobProgress);

    if (type === 'gdrive') {
      // Use Google Drive API for Google Drive files
      downloadResult = await googleDriveDownloader.download({
        url,
        fileName,
        onProgress: async (progress) => {
          await job.updateProgress({
            stage: 'downloading',
            percentage: progress.percentage,
            message: `Downloading from Google Drive: ${progress.percentage}%`,
          } as ImportJobProgress);
        },
      });
    } else {
      // Use regular downloader for direct URLs
      downloadResult = await downloader.download({
        url,
        type,
        fileName,
        onProgress: async (progress) => {
          await job.updateProgress({
            stage: 'downloading',
            percentage: progress.percentage,
            message: `Downloading: ${progress.percentage}%`,
          } as ImportJobProgress);
        },
      });
    }

    tempFilePath = downloadResult.filePath;
    tempFiles = [tempFilePath]; // Track temp files for cleanup
    
    // Update recovery state with download progress
    await recoveryService.updateJobProgress(job.id!, {
      stage: 'downloading',
      percentage: 100,
      message: 'Download completed',
    }, tempFiles);

    // Generate unique filename for storage
    const ext = path.extname(downloadResult.fileName);
    const baseName = path.basename(downloadResult.fileName, ext);
    const uniqueFileName = `${baseName}-${nanoid(8)}${ext}`;

    // Upload stage - Use chunked uploader for large files
    await job.updateProgress({
      stage: 'uploading',
      percentage: 0,
      message: 'Starting upload to Bunny Storage...',
    } as ImportJobProgress);

    const fileSize = downloadResult.fileSize;
    const useChunkedUpload = fileSize > 100 * 1024 * 1024; // Use chunked for files > 100MB

    let uploadResult;
    if (useChunkedUpload) {
      logger.info('Using chunked upload for large file', { fileSize, fileName: uniqueFileName });
      uploadResult = await chunkedUploader.upload({
        filePath: tempFilePath,
        fileName: uniqueFileName,
        onProgress: async (progress) => {
          const message = progress.totalChunks 
            ? `Uploading chunk ${progress.currentChunk}/${progress.totalChunks}: ${progress.percentage}%`
            : `Uploading: ${progress.percentage}%`;
          const progressData = {
            stage: 'uploading',
            percentage: progress.percentage,
            message,
          };
          await job.updateProgress(progressData as ImportJobProgress);
          
          // Update recovery state with upload progress
          await recoveryService.updateJobProgress(job.id!, progressData, tempFiles);
        },
      });
    } else {
      uploadResult = await bunnyStorage.upload({
        filePath: tempFilePath,
        fileName: uniqueFileName,
        onProgress: async (progress) => {
          const progressData = {
            stage: 'uploading',
            percentage: progress.percentage,
            message: `Uploading: ${progress.percentage}%`,
          };
          await job.updateProgress(progressData as ImportJobProgress);
          
          // Update recovery state with upload progress
          await recoveryService.updateJobProgress(job.id!, progressData, tempFiles);
        },
      });
    }

    // Clean up temporary file
    if (type === 'gdrive') {
      googleDriveDownloader.cleanupFile(tempFilePath);
    } else {
      downloader.cleanupFile(tempFilePath);
    }

    const result: ImportJobResult = {
      success: true,
      cdnUrl: uploadResult.cdnUrl,
      fileName: uploadResult.fileName,
      fileSize: uploadResult.fileSize,
      retryCount: job.attemptsMade,
    };

    // Send success notification
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      await sendTelegramNotification({
        type: 'success',
        jobId: job.id || 'unknown',
        message: `✅ Import completed successfully\n\nFile: ${uploadResult.fileName}\nSize: ${(uploadResult.fileSize / 1024 / 1024).toFixed(2)}MB\nCDN URL: ${uploadResult.cdnUrl}`,
      });
    }

    // Mark job as completed in recovery service
    await recoveryService.completeJob(job.id!);

    return result;
  } catch (error) {
    // Clean up on failure
    if (tempFilePath) {
      if (type === 'gdrive') {
        googleDriveDownloader.cleanupFile(tempFilePath);
      } else {
        downloader.cleanupFile(tempFilePath);
      }
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    logger.error('Import job failed', {
      jobId: job.id,
      url,
      error: errorMessage,
      attemptsMade: job.attemptsMade,
    });

    // Send failure notification if this was the last attempt
    if (job.attemptsMade >= env.MAX_RETRY_ATTEMPTS) {
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        await sendTelegramNotification({
          type: 'failure',
          jobId: job.id || 'unknown',
          message: `❌ Import failed after ${job.attemptsMade} attempts\n\nURL: ${url}\nError: ${errorMessage}`,
        });
      }
    }

    // Mark job as failed in recovery service
    await recoveryService.failJob(job.id!, error instanceof Error ? error : new Error(String(error)));

    throw error;
  }
}