import axios, { AxiosProgressEvent } from 'axios';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { nanoid } from 'nanoid';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { parseGoogleDriveUrl, isGoogleDriveUrl } from '../utils/googleDrive';
import { retry } from '../utils/retry';

export interface DownloadOptions {
  url: string;
  type: 'gdrive' | 'direct';
  fileName?: string;
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
}

export class Downloader {
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

  async download(options: DownloadOptions): Promise<DownloadResult> {
    const { url, type, fileName, onProgress } = options;

    let downloadUrl = url;
    let suggestedFileName = fileName;

    if (type === 'gdrive' && isGoogleDriveUrl(url)) {
      const driveInfo = parseGoogleDriveUrl(url);
      if (!driveInfo) {
        throw new Error('Invalid Google Drive URL');
      }
      downloadUrl = driveInfo.directUrl;
      suggestedFileName = suggestedFileName || driveInfo.fileName;
    }

    const tempFileName = `${nanoid()}_${suggestedFileName || 'download'}`;
    const tempFilePath = path.join(this.tempDir, tempFileName);

    try {
      const result = await retry(
        () => this.performDownload(downloadUrl, tempFilePath, onProgress),
        {
          maxAttempts: env.MAX_RETRY_ATTEMPTS,
          delay: 2000,
          onRetry: (error, attempt) => {
            logger.warn(`Download retry attempt ${attempt}`, {
              url: downloadUrl,
              error: error.message,
            });
          },
        }
      );

      return result;
    } catch (error) {
      // Clean up on failure
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
      throw error;
    }
  }

  private async performDownload(
    url: string,
    filePath: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    const writer = fs.createWriteStream(filePath);

    try {
      const response = await axios({
        method: 'GET',
        url,
        responseType: 'stream',
        timeout: env.DOWNLOAD_TIMEOUT_MS,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        onDownloadProgress: (progressEvent: AxiosProgressEvent) => {
          if (onProgress && progressEvent.total) {
            const progress: DownloadProgress = {
              downloadedBytes: progressEvent.loaded,
              totalBytes: progressEvent.total,
              percentage: Math.round((progressEvent.loaded / progressEvent.total) * 100),
            };
            onProgress(progress);
          }
        },
      });

      const contentLength = parseInt(response.headers['content-length'] || '0', 10);
      const contentDisposition = response.headers['content-disposition'];
      let fileName = path.basename(filePath);

      // Try to extract filename from Content-Disposition header
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (filenameMatch && filenameMatch[1]) {
          fileName = filenameMatch[1].replace(/['"]/g, '');
        }
      }

      // Check file size limit
      if (contentLength > env.MAX_FILE_SIZE_MB * 1024 * 1024) {
        throw new Error(`File size exceeds limit of ${env.MAX_FILE_SIZE_MB}MB`);
      }

      await pipeline(response.data, writer);

      const stats = fs.statSync(filePath);

      logger.info('File downloaded successfully', {
        url,
        filePath,
        fileSize: stats.size,
      });

      return {
        filePath,
        fileName,
        fileSize: stats.size,
      };
    } catch (error) {
      writer.destroy();
      throw error;
    }
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