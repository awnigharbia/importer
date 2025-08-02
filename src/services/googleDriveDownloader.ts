import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import axios from 'axios';
import { getDownloadLinkFromID } from '@abrifq/google-drive-downloader';
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
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    try {
      // Get the direct download URL using @abrifq/google-drive-downloader
      logger.info('Getting direct download URL from Google Drive', { fileId });
      const directDownloadUrl = await getDownloadLinkFromID(fileId);
      
      if (!directDownloadUrl) {
        throw new Error('Could not get direct download URL from Google Drive. File may be private or deleted.');
      }

      logger.info('Got direct download URL, starting download', { 
        fileId, 
        downloadUrl: directDownloadUrl.substring(0, 100) + '...' // Log first 100 chars for debugging
      });

      // Download the file using axios with streaming
      const response = await axios({
        method: 'GET',
        url: directDownloadUrl,
        responseType: 'stream',
        timeout: env.DOWNLOAD_TIMEOUT_MS,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;

      // Create write stream
      const writer = fs.createWriteStream(filePath);

      // Handle progress tracking
      response.data.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        
        if (onProgress && totalBytes > 0) {
          const percentage = Math.round((downloadedBytes / totalBytes) * 100);
          onProgress({
            downloadedBytes,
            totalBytes,
            percentage,
          });
        }
      });

      // Pipe the response to file
      response.data.pipe(writer);

      // Wait for download to complete
      await new Promise<void>((resolve, reject) => {
        writer.on('finish', () => resolve());
        writer.on('error', reject);
        response.data.on('error', reject);
      });

      // Check if file was downloaded successfully
      if (!fs.existsSync(filePath)) {
        throw new Error('File download failed - file not found after download');
      }

      const stats = fs.statSync(filePath);
      const fileName = path.basename(filePath);

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