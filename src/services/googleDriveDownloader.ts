import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { parseGoogleDriveUrl } from '../utils/googleDrive';
import { retry } from '../utils/retry';

export interface GoogleDriveDownloadOptions {
  url: string;
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
  mimeType: string;
}

export class GoogleDriveDownloader {
  private drive;
  private tempDir: string;

  constructor() {
    // Initialize with API key if available, otherwise it will work with public files
    const options: any = { version: 'v3' };
    if (env.GOOGLE_API_KEY) {
      options.auth = env.GOOGLE_API_KEY;
    }
    this.drive = google.drive(options);
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
      // First, get file metadata to validate it's a video
      const fileMetadata = await this.getFileMetadata(driveInfo.fileId);
      
      if (!this.isVideoFile(fileMetadata.mimeType)) {
        throw new Error(`File is not a video. Detected type: ${fileMetadata.mimeType}`);
      }

      // Check file size limit
      const fileSize = parseInt(fileMetadata.size || '0', 10);
      if (fileSize > env.MAX_FILE_SIZE_MB * 1024 * 1024) {
        throw new Error(`File size exceeds limit of ${env.MAX_FILE_SIZE_MB}MB`);
      }

      const suggestedFileName = fileName || fileMetadata.name || 'download.mp4';
      const tempFileName = `${nanoid()}_${suggestedFileName}`;
      const tempFilePath = path.join(this.tempDir, tempFileName);

      // Download the file
      const result = await retry(
        () => this.performDownload(driveInfo.fileId, tempFilePath, fileSize, onProgress),
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

      return {
        ...result,
        mimeType: fileMetadata.mimeType || 'video/mp4',
      };
    } catch (error) {
      logger.error('Google Drive download failed', {
        url,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  private async getFileMetadata(fileId: string): Promise<any> {
    try {
      const response = await this.drive.files.get({
        fileId,
        fields: 'id, name, mimeType, size',
        supportsAllDrives: true,
      });

      return response.data;
    } catch (error: any) {
      if (error.code === 404) {
        throw new Error('File not found or access denied');
      }
      throw new Error(`Failed to get file metadata: ${error.message}`);
    }
  }

  private isVideoFile(mimeType?: string | null): boolean {
    if (!mimeType) return false;
    
    const videoMimeTypes = [
      'video/mp4',
      'video/mpeg',
      'video/quicktime',
      'video/x-msvideo',
      'video/x-ms-wmv',
      'video/webm',
      'video/x-flv',
      'video/3gpp',
      'video/x-matroska',
      'application/x-mpegURL',
      'video/MP2T',
      'video/ogg',
      'video/x-m4v',
    ];

    return videoMimeTypes.includes(mimeType);
  }

  private async performDownload(
    fileId: string,
    filePath: string,
    totalSize: number,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    const dest = fs.createWriteStream(filePath);
    let downloadedBytes = 0;

    try {
      const response = await this.drive.files.get(
        {
          fileId,
          alt: 'media',
          supportsAllDrives: true,
        },
        { responseType: 'stream' }
      );

      response.data
        .on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (onProgress && totalSize > 0) {
            const progress: DownloadProgress = {
              downloadedBytes,
              totalBytes: totalSize,
              percentage: Math.round((downloadedBytes / totalSize) * 100),
            };
            onProgress(progress);
          }
        })
        .on('error', (err: Error) => {
          dest.destroy();
          throw err;
        })
        .pipe(dest);

      await new Promise<void>((resolve, reject) => {
        dest.on('finish', () => resolve());
        dest.on('error', reject);
      });

      const stats = fs.statSync(filePath);
      const fileName = path.basename(filePath);

      logger.info('Google Drive file downloaded successfully', {
        fileId,
        filePath,
        fileSize: stats.size,
      });

      return {
        filePath,
        fileName,
        fileSize: stats.size,
        mimeType: 'video/mp4',
      };
    } catch (error) {
      dest.destroy();
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
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