import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { drive } from '@googleapis/drive';
import axios from 'axios';
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
  private driveApi: any;

  constructor() {
    this.tempDir = path.resolve(env.TEMP_DIR);
    this.ensureTempDir();
    
    // Initialize Google Drive API with API key
    if (env.GOOGLE_API_KEY) {
      this.driveApi = drive({
        version: 'v3',
        auth: env.GOOGLE_API_KEY
      });
    } else {
      this.driveApi = drive({
        version: 'v3'
      });
    }
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

      // Download the file
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
      logger.info('Downloading Google Drive file', { fileId });
      
      // Try API download first if API key is available
      if (env.GOOGLE_API_KEY) {
        try {
          return await this.apiDownload(fileId, filePath, onProgress);
        } catch (apiError: any) {
          logger.warn('API download failed, falling back to direct download', { 
            error: apiError.message 
          });
        }
      }
      
      // Fallback to direct download
      return await this.directDownload(fileId, filePath, onProgress);
    } catch (error: any) {
      // Clean up on failure
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      
      const errorMessage = error?.message || 'Unknown error';
      
      // Handle common errors
      if (error?.code === 403 || errorMessage.includes('403')) {
        throw new Error('File access denied - file may be private or require permissions');
      } else if (error?.code === 404 || errorMessage.includes('404')) {
        throw new Error('File not found - check if the Google Drive URL is correct');
      } else if (errorMessage.includes('quota')) {
        throw new Error('Google Drive download quota exceeded - try again later');
      }
      
      throw new Error(`Google Drive download failed: ${errorMessage}`);
    }
  }

  private async apiDownload(
    fileId: string,
    filePath: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    logger.info('Attempting API download with key', { fileId });
    
    // Get file metadata
    const metadataResponse = await this.driveApi.files.get({
      fileId: fileId,
      fields: 'id, name, size, mimeType',
      supportsAllDrives: true,
    });

    const fileSize = metadataResponse.data?.size ? parseInt(metadataResponse.data.size) : 0;
    const fileName = metadataResponse.data?.name || path.basename(filePath);
    const mimeType = metadataResponse.data?.mimeType || 'video/mp4';

    // Download the file
    const dest = fs.createWriteStream(filePath);
    let downloadedBytes = 0;

    const response = await this.driveApi.files.get(
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

    logger.info('Google Drive file downloaded successfully via API', {
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

  private async directDownload(
    fileId: string,
    filePath: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    logger.info('Attempting direct download without authentication', { fileId });
    
    const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    
    // First, try to get the file with a HEAD request
    try {
      const headResponse = await axios.head(downloadUrl, {
        maxRedirects: 0,
        validateStatus: (status) => status < 400,
      });

      const contentLength = headResponse.headers['content-length'];
      if (contentLength && parseInt(contentLength) > 0) {
        // Direct download is possible
        return await this.downloadWithAxios(downloadUrl, filePath, onProgress);
      }
    } catch (error) {
      // Continue to confirmation page handling
    }

    // Handle confirmation page for large files
    const response = await axios.get(downloadUrl, {
      maxRedirects: 5,
      validateStatus: (status) => status < 500,
    });

    // Look for confirmation token in the response
    const html = response.data;
    let finalUrl = downloadUrl;

    // Try to find confirmation URL
    const confirmMatch = html.match(/confirm=([a-zA-Z0-9_-]+)/);
    if (confirmMatch) {
      finalUrl = `${downloadUrl}&confirm=${confirmMatch[1]}`;
    } else {
      // Try alternative pattern
      const downloadMatch = html.match(/href="(\/uc\?export=download[^"]*)"/);
      if (downloadMatch) {
        finalUrl = `https://drive.google.com${downloadMatch[1].replace(/&amp;/g, '&')}`;
      }
    }

    return await this.downloadWithAxios(finalUrl, filePath, onProgress);
  }

  private async downloadWithAxios(
    url: string,
    filePath: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: env.DOWNLOAD_TIMEOUT_MS,
    });

    const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
    let downloadedBytes = 0;

    const writer = fs.createWriteStream(filePath);

    if (onProgress) {
      response.data.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const percentage = Math.round((downloadedBytes / totalBytes) * 100);
          onProgress({
            downloadedBytes,
            totalBytes,
            percentage,
          });
        }
      });
    }

    response.data.pipe(writer);

    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.on('error', reject);
    });

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

    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const mimeType = this.getMimeTypeFromExtension(ext);

    logger.info('Google Drive file downloaded successfully via direct download', {
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