import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
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
  private drive: any;
  private auth: OAuth2Client | string | undefined;

  constructor() {
    this.tempDir = path.resolve(env.TEMP_DIR);
    this.ensureTempDir();
    
    // Initialize authentication
    this.auth = this.setupAuth();
    
    // Initialize Google Drive API
    if (this.auth) {
      this.drive = google.drive({ 
        version: 'v3',
        auth: this.auth
      });
    } else {
      this.drive = google.drive({ 
        version: 'v3'
      });
    }
  }

  private setupAuth(): OAuth2Client | string | undefined {
    // If we have OAuth2 credentials, use them
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
      const oauth2Client = new OAuth2Client(
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET
      );
      
      oauth2Client.setCredentials({
        refresh_token: env.GOOGLE_REFRESH_TOKEN
      });
      
      logger.info('Using OAuth2 authentication for Google Drive');
      return oauth2Client;
    }
    
    // Otherwise, use API key if available
    if (env.GOOGLE_API_KEY) {
      logger.info('Using API key authentication for Google Drive');
      return env.GOOGLE_API_KEY;
    }
    
    logger.warn('No Google Drive authentication configured');
    return undefined;
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

      // Download the file using the copy-download-delete approach
      const result = await retry(
        () => this.performCopyDownloadDelete(driveInfo.fileId, tempFilePath, onProgress),
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

  private async performCopyDownloadDelete(
    fileId: string,
    filePath: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    let copiedFileId: string | null = null;
    
    try {
      // If OAuth2 is configured, copy the file first
      if (this.auth instanceof OAuth2Client) {
        logger.info('Copying file to user Drive', { fileId });
        
        // Get original file metadata
        const originalFile = await this.drive.files.get({
          fileId: fileId,
          fields: 'id, name, size, mimeType',
          supportsAllDrives: true,
        });
        
        // Copy the file to user's Drive
        const copyResponse = await this.drive.files.copy({
          fileId: fileId,
          requestBody: {
            name: `temp_${originalFile.data.name || 'download'}`,
          },
          supportsAllDrives: true,
          fields: 'id',
        });
        
        copiedFileId = copyResponse.data.id;
        logger.info('File copied to user Drive', { copiedFileId });
        
        // Download the copied file
        const result = await this.downloadFile(copiedFileId!, filePath, onProgress);
        
        return result;
      } else {
        // Direct download without copying
        logger.info('Downloading file directly (no OAuth2)', { fileId });
        return await this.downloadFile(fileId, filePath, onProgress);
      }
    } finally {
      // Clean up copied file if it exists
      if (copiedFileId && this.auth instanceof OAuth2Client) {
        try {
          logger.info('Cleaning up copied file', { copiedFileId });
          await this.drive.files.delete({
            fileId: copiedFileId,
            supportsAllDrives: true,
          });
          logger.info('Copied file deleted successfully', { copiedFileId });
        } catch (cleanupError) {
          logger.error('Failed to cleanup copied file', { 
            copiedFileId, 
            error: cleanupError 
          });
        }
      }
    }
  }

  private async downloadFile(
    fileId: string,
    filePath: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    logger.info('Downloading Google Drive file', { fileId });
    
    // Get file metadata first
    const metadataResponse = await this.drive.files.get({
      fileId: fileId,
      fields: 'id, name, size, mimeType',
      supportsAllDrives: true,
    }).catch((error: any) => {
      logger.warn('Could not fetch file metadata', { error: error.message });
      return null;
    });

    const fileSize = metadataResponse?.data?.size ? parseInt(metadataResponse.data.size) : 0;
    const fileName = metadataResponse?.data?.name || path.basename(filePath);
    const mimeType = metadataResponse?.data?.mimeType || 'video/mp4';

    // Download the file
    const dest = fs.createWriteStream(filePath);
    let downloadedBytes = 0;

    const response = await this.drive.files.get(
      {
        fileId: fileId,
        alt: 'media',
        supportsAllDrives: true,
      },
      {
        responseType: 'stream',
      }
    );

    // Handle progress
    response.data.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      if (onProgress && fileSize > 0) {
        const percentage = Math.round((downloadedBytes / fileSize) * 100);
        onProgress({
          downloadedBytes,
          totalBytes: fileSize,
          percentage,
        });
      }
    });

    // Pipe to file
    response.data.pipe(dest);

    // Wait for download completion
    await new Promise<void>((resolve, reject) => {
      dest.on('finish', resolve);
      dest.on('error', reject);
      response.data.on('error', reject);
    });

    // Validate the downloaded file
    if (!fs.existsSync(filePath)) {
      throw new Error('File download failed - file not found after download');
    }

    const stats = fs.statSync(filePath);
    
    if (stats.size === 0) {
      throw new Error('Downloaded file is empty');
    }

    // Check file size limit
    if (stats.size > env.MAX_FILE_SIZE_MB * 1024 * 1024) {
      fs.unlinkSync(filePath);
      throw new Error(`File size exceeds limit of ${env.MAX_FILE_SIZE_MB}MB`);
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
      mimeType,
    };
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