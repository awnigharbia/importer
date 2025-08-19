import { Job } from 'bullmq';
import path from 'path';
import { nanoid } from 'nanoid';
import { ImportJobData, ImportJobResult, ImportJobProgress } from '../queues/importQueue';
import { Downloader } from '../services/downloader';
import { GoogleDriveDownloader } from '../services/googleDriveDownloader';
import { YouTubeDownloader } from '../services/youtubeDownloader';
import { BunnyStorage } from '../services/bunnyStorage';
import { EncodeAdminService } from '../services/encodeAdmin';
import { sendTelegramNotification } from '../services/telegram';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { getJobRecoveryService } from '../services/jobRecovery';
import { getMemoryMonitor } from '../utils/memoryMonitor';

export async function processImportJob(
  job: Job<ImportJobData, ImportJobResult>
): Promise<ImportJobResult> {
  const { url, type, fileName, videoId } = job.data;
  const downloader = new Downloader();
  const googleDriveDownloader = new GoogleDriveDownloader();
  const youtubeDownloader = new YouTubeDownloader();
  const bunnyStorage = new BunnyStorage();
  const encodeAdminService = new EncodeAdminService();
  const recoveryService = getJobRecoveryService();
  const memoryMonitor = getMemoryMonitor();

  let downloadResult;
  let tempFilePath: string | null = null;
  let tempFiles: string[] = [];

  try {
    // Log initial memory usage
    memoryMonitor.logCurrentMemoryUsage();

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
      downloadResult = await googleDriveDownloader.downloadFile(url, {
        ...(fileName && { fileName }),
        outputPath: env.TEMP_DIR || '/tmp'
      });
    } else if (type === 'youtube') {
      // Use YouTube downloader for YouTube URLs
      const videoId = YouTubeDownloader.extractVideoId(url);
      if (!videoId) {
        throw new Error('Invalid YouTube URL: cannot extract video ID');
      }

      downloadResult = await youtubeDownloader.download({
        videoId,
        outputPath: env.TEMP_DIR || '/tmp',
        onProgress: (progress) => {
          void job.updateProgress({
            stage: 'downloading',
            percentage: progress.percentage,
            message: progress.message,
          } as ImportJobProgress);
        },
      });
    } else if (type === 'local') {
      // File is already stored locally, no download needed
      await job.updateProgress({
        stage: 'downloading',
        percentage: 100,
        message: 'Local file ready for upload',
      } as ImportJobProgress);

      // Verify file exists
      if (!require('fs').existsSync(url)) {
        throw new Error(`Local file not found: ${url}`);
      }

      const stats = require('fs').statSync(url);
      const actualFileName = fileName || require('path').basename(url);

      downloadResult = {
        filePath: url,
        fileName: actualFileName,
        fileSize: stats.size,
      };
    } else {
      // Use regular downloader for direct URLs
      downloadResult = await downloader.download({
        url,
        type,
        fileName: fileName || undefined,
        onProgress: (progress) => {
          void job.updateProgress({
            stage: 'downloading',
            percentage: progress.percentage,
            message: `Downloading: ${progress.percentage}%`,
          } as ImportJobProgress);
        },
      });
    }

    tempFilePath = downloadResult.filePath;
    tempFiles = [tempFilePath]; // Track temp files for cleanup

    // Log memory usage after download
    logger.info('Download completed, checking memory usage');
    memoryMonitor.logCurrentMemoryUsage();

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

    // Upload stage - Use resilient single file upload
    await job.updateProgress({
      stage: 'uploading',
      percentage: 0,
      message: 'Starting upload to Bunny Storage...',
    } as ImportJobProgress);

    const uploadResult = await bunnyStorage.upload({
      filePath: tempFilePath!,
      fileName: uniqueFileName,
      onProgress: (progress) => {
        const progressData = {
          stage: 'uploading',
          percentage: progress.percentage,
          message: `Uploading: ${progress.percentage}%`,
        };
        void job.updateProgress(progressData as ImportJobProgress);

        // Update recovery state with upload progress
        void recoveryService.updateJobProgress(job.id!, progressData, tempFiles);
      },
    });

    // Verify CDN URL is accessible
    setTimeout(async () => {
      try {
        const isAccessible = await bunnyStorage.verifyCdnAccess(uniqueFileName);
        if (!isAccessible) {
          logger.warn('CDN URL verification failed, file may not be immediately accessible', {
            fileName: uniqueFileName,
            cdnUrl: uploadResult.cdnUrl
          });
        }
      } catch (error) {
        logger.warn('CDN verification error', { error });
      }
    }, 5000); // Wait 5 seconds for CDN propagation

    // Integrate with encode-admin API
    if (videoId) {
      // For TUS uploads, update existing video with source link
      try {
        await encodeAdminService.updateVideoSourceLink(videoId, uploadResult.cdnUrl);
        logger.info('Updated video source link in encode-admin', {
          videoId,
          cdnUrl: uploadResult.cdnUrl,
        });
      } catch (error) {
        logger.error('Failed to update video in encode-admin', {
          videoId,
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't fail the job if encode-admin update fails
      }
    } else {
      // For regular imports, create a new video
      try {
        const videoName = fileName || path.basename(url);
        const video = await encodeAdminService.createVideo({
          name: videoName,
          sourceLink: uploadResult.cdnUrl,
        });
        logger.info('Created video in encode-admin', {
          videoId: video.id,
          cdnUrl: uploadResult.cdnUrl,
        });
      } catch (error) {
        logger.error('Failed to create video in encode-admin', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't fail the job if encode-admin creation fails
      }
    }

    // Clean up temporary file
    if (type === 'gdrive' || type === 'youtube') {
      // Clean up temporary file
      if (require('fs').existsSync(tempFilePath!)) {
        require('fs').unlinkSync(tempFilePath!);
      }
    } else if (type === 'local') {
      // For local files (TUS uploads), clean up the temporary upload file
      if (require('fs').existsSync(tempFilePath!)) {
        require('fs').unlinkSync(tempFilePath!);
      }
    } else {
      downloader.cleanupFile(tempFilePath!);
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

    // Log final memory usage
    logger.info('Job completed, final memory check');
    memoryMonitor.logCurrentMemoryUsage();

    // Mark job as completed in recovery service
    await recoveryService.completeJob(job.id!);

    return result;
  } catch (error) {
    // Clean up on failure
    if (tempFilePath) {
      if (type === 'gdrive' || type === 'youtube') {
        // Clean up temporary file
        if (require('fs').existsSync(tempFilePath!)) {
          require('fs').unlinkSync(tempFilePath!);
        }
      } else if (type === 'local') {
        // For local files (TUS uploads), clean up the temporary upload file
        if (require('fs').existsSync(tempFilePath!)) {
          require('fs').unlinkSync(tempFilePath!);
        }
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