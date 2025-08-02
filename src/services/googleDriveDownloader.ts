import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { downloadFile } from 'simple-googledrive-downloader';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { parseGoogleDriveUrl } from '../utils/googleDrive';
import { retry } from '../utils/retry';

export interface GoogleDriveDownloadOptions {
  url: string;
  fileName?: string | undefined;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  percentage: number;
}

export interface DownloadResult {
  filePath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export class GoogleDriveDownloader {
  private tempDir: string;

  constructor() {
    this.tempDir = path.resolve(env.TEMP_DIR);
    this.ensureTempDir();
  }

  private ensureTempDir(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async download(options: GoogleDriveDownloadOptions): Promise<DownloadResult> {
    const { url, fileName, onProgress } = options;

    const driveInfo = parseGoogleDriveUrl(url);
    if (!driveInfo) {
      throw new Error('Invalid Google Drive URL');
    }

    try {
      // Generate a temporary file name
      const suggestedFileName = fileName || 'download.mp4';
      const tempFileName = `${nanoid()}_${suggestedFileName}`;
      const tempFilePath = path.join(this.tempDir, tempFileName);

      // Download the file using the @abrifq/google-drive-downloader package
      const result = await retry(
        () => this.performDownload(driveInfo.fileId, tempFilePath, onProgress),
        {
          maxAttempts: env.MAX_RETRY_ATTEMPTS,
          delay: 2000,
          onRetry: (error, attempt) => {
            logger.warn(`Google Drive download retry attempt ${attempt}`, {
              fileId: driveInfo.fileId,
              error: error.message,
            });
          },
        }
      );

      return result;
    } catch (error) {
      logger.error('Google Drive download failed', {
        url,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  private async performDownload(
    fileId: string,
    filePath: string,
    _onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    try {
      logger.info('Downloading Google Drive file using simple-googledrive-downloader', { fileId });
      
      // Extract directory, filename and extension from filePath
      const dirPath = path.dirname(filePath);
      const fullFileName = path.basename(filePath);
      const extIndex = fullFileName.lastIndexOf('.');
      const filename = extIndex > 0 ? fullFileName.substring(0, extIndex) : fullFileName;
      const extension = extIndex > 0 ? fullFileName.substring(extIndex + 1) : 'mp4';
      
      // Use simple-googledrive-downloader to download the file
      const downloadedPath = await downloadFile(fileId, dirPath, filename, extension);
      
      if (!downloadedPath) {
        throw new Error('Download failed - simple-googledrive-downloader returned null');
      }

      // The downloaded file might be at downloadedPath instead of filePath
      // Check both locations
      const actualFilePath = fs.existsSync(downloadedPath) ? downloadedPath : filePath;
      
      if (!fs.existsSync(actualFilePath)) {
        throw new Error('File download failed - file not found after download');
      }

      const stats = fs.statSync(actualFilePath);
      const fileName = path.basename(actualFilePath);

      // Validate file
      if (stats.size === 0) {
        throw new Error('Downloaded file is empty');
      }

      // Check file size limit
      if (stats.size > env.MAX_FILE_SIZE_MB * 1024 * 1024) {
        // Clean up the file before throwing error
        fs.unlinkSync(filePath);
        throw new Error(`File size exceeds limit of ${env.MAX_FILE_SIZE_MB}MB`);
      }

      // Basic video file validation by extension
      const ext = path.extname(fileName).toLowerCase();
      const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp'];
      
      if (!videoExtensions.includes(ext)) {
        logger.warn('Downloaded file may not be a video based on extension', { fileName, ext });
      }

      // Move file to expected location if needed
      if (actualFilePath !== filePath && fs.existsSync(actualFilePath)) {
        fs.renameSync(actualFilePath, filePath);
      }

      logger.info('Google Drive file downloaded successfully', {
        fileId,
        filePath,
        fileSize: stats.size,
        fileName,
      });

      return {
        filePath,
        fileName,
        fileSize: stats.size,
        mimeType: this.getMimeTypeFromExtension(ext),
      };
    } catch (error) {
      // Clean up on failure
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Handle common Google Drive errors
      if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
        throw new Error('File access denied - file may be private or require permissions');
      } else if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
        throw new Error('File not found - check if the Google Drive URL is correct');
      } else if (errorMessage.includes('quota')) {
        throw new Error('Google Drive download quota exceeded - try again later');
      }
      
      throw new Error(`Google Drive download failed: ${errorMessage}`);
    }
  }


  private getMimeTypeFromExtension(ext: string): string {
    const mimeMap: { [key: string]: string } = {
      '.mp4': 'video/mp4',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
      '.wmv': 'video/x-ms-wmv',
      '.flv': 'video/x-flv',
      '.webm': 'video/webm',
      '.m4v': 'video/x-m4v',
      '.3gp': 'video/3gpp',
    };
    
    return mimeMap[ext] || 'video/mp4';
  }

  cleanupFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info('Cleaned up temporary file', { filePath });
      }
    } catch (error) {
      logger.error('Failed to cleanup file', { filePath, error });
    }
  }
}