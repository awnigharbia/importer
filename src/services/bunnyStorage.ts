import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { retry } from '../utils/retry';

export interface UploadOptions {
  filePath: string;
  fileName: string;
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  percentage: number;
}

export interface UploadResult {
  url: string;
  cdnUrl: string;
  fileName: string;
  fileSize: number;
}

export class BunnyStorage {
  private storageUrl: string;
  private cdnUrl: string;

  constructor() {
    this.storageUrl = `https://storage.bunnycdn.com/${env.BUNNY_STORAGE_ZONE}`;
    this.cdnUrl = this.validateCdnUrl(env.BUNNY_CDN_URL);
  }

  private validateCdnUrl(url: string): string {
    // Remove trailing slash
    let cleanUrl = url.replace(/\/$/, '');
    
    // Ensure it starts with http:// or https://
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = `https://${cleanUrl}`;
    }
    
    logger.debug('CDN URL validated', { original: url, validated: cleanUrl });
    return cleanUrl;
  }

  async upload(options: UploadOptions): Promise<UploadResult> {
    const { filePath, fileName, onProgress } = options;

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    const uploadUrl = `${this.storageUrl}/${fileName}`;

    try {
      await retry(
        () => this.performUpload(filePath, uploadUrl, fileSize, onProgress),
        {
          maxAttempts: env.MAX_RETRY_ATTEMPTS,
          delay: 2000,
          onRetry: (error, attempt) => {
            logger.warn(`Upload retry attempt ${attempt}`, {
              fileName,
              error: error.message,
            });
          },
        }
      );

      // Generate clean CDN URL
      const cdnUrl = `${this.cdnUrl}/${fileName}`;

      // Verify CDN URL is accessible (optional check)
      logger.info('File uploaded successfully to Bunny Storage', {
        fileName,
        fileSize,
        storageUrl: uploadUrl,
        cdnUrl,
        cdnUrlComponents: {
          base: this.cdnUrl,
          fileName,
          full: cdnUrl
        }
      });

      return {
        url: uploadUrl,
        cdnUrl,
        fileName,
        fileSize,
      };
    } catch (error) {
      logger.error('Failed to upload file to Bunny Storage', {
        fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async performUpload(
    filePath: string,
    uploadUrl: string,
    fileSize: number,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<void> {
    // Use very small buffer size for large files to minimize RAM usage
    const bufferSize = Math.min(env.STREAM_BUFFER_SIZE * 1024, 8192); // Max 8KB buffer
    
    const fileStream = fs.createReadStream(filePath, {
      highWaterMark: bufferSize,
    });
    
    let uploadedBytes = 0;
    let lastProgressUpdate = 0;
    const PROGRESS_UPDATE_INTERVAL = 1024 * 1024; // Update progress every 1MB

    // Create a minimal transform stream to track progress
    const { Transform } = await import('stream');
    const progressStream = new Transform({
      highWaterMark: bufferSize,
      objectMode: false,
      transform(chunk, _encoding, callback) {
        uploadedBytes += chunk.length;
        
        // Throttle progress updates to reduce overhead
        if (onProgress && (uploadedBytes - lastProgressUpdate) >= PROGRESS_UPDATE_INTERVAL) {
          const progress: UploadProgress = {
            uploadedBytes,
            totalBytes: fileSize,
            percentage: Math.round((uploadedBytes / fileSize) * 100),
          };
          
          // Use setImmediate to prevent blocking
          setImmediate(() => onProgress(progress));
          lastProgressUpdate = uploadedBytes;
        }
        
        callback(null, chunk);
      },
    });

    // Add error handlers to streams to prevent crashes
    fileStream.on('error', (error) => {
      logger.error('File stream error during upload', { error: error.message });
      progressStream.destroy();
    });

    progressStream.on('error', (error) => {
      logger.error('Progress stream error during upload', { error: error.message });
      fileStream.destroy();
    });

    try {
      const response = await axios({
        method: 'PUT',
        url: uploadUrl,
        headers: {
          'AccessKey': env.BUNNY_ACCESS_KEY,
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileSize.toString(),
        },
        data: fileStream.pipe(progressStream),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: env.DOWNLOAD_TIMEOUT_MS * 2, // Double timeout for uploads
        
        // Add resilience options
        validateStatus: (status) => status >= 200 && status < 300,
        maxRedirects: 3,
        
        // Enable compression if server supports it
        decompress: true,
      });

      // Send final progress update
      if (onProgress) {
        setImmediate(() => onProgress({
          uploadedBytes: fileSize,
          totalBytes: fileSize,
          percentage: 100,
        }));
      }
      
      logger.debug('Upload completed successfully', { 
        status: response.status,
        uploadedBytes: fileSize 
      });
      
    } catch (error) {
      // Clean up streams on error
      if (fileStream && !fileStream.destroyed) {
        fileStream.destroy();
      }
      if (progressStream && !progressStream.destroyed) {
        progressStream.destroy();
      }
      
      if (axios.isAxiosError(error)) {
        if (error.response) {
          const errorMsg = `Bunny Storage API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`;
          logger.error('Upload API error', { 
            status: error.response.status, 
            data: error.response.data,
            uploadedBytes 
          });
          throw new Error(errorMsg);
        } else if (error.request) {
          logger.error('Upload network error', { uploadedBytes });
          throw new Error('No response from Bunny Storage API - network error');
        } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
          logger.error('Upload connection error', { code: error.code, uploadedBytes });
          throw new Error(`Connection error during upload: ${error.code}`);
        }
      }
      
      logger.error('Upload failed with unknown error', { 
        error: error instanceof Error ? error.message : String(error),
        uploadedBytes 
      });
      throw error;
    } finally {
      // Ensure streams are always cleaned up
      try {
        if (fileStream && !fileStream.destroyed) {
          fileStream.destroy();
        }
        if (progressStream && !progressStream.destroyed) {
          progressStream.destroy();
        }
      } catch (cleanupError) {
        logger.warn('Error during stream cleanup', { 
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) 
        });
      }
    }
  }

  async delete(fileName: string): Promise<void> {
    const deleteUrl = `${this.storageUrl}/${fileName}`;

    try {
      await axios({
        method: 'DELETE',
        url: deleteUrl,
        headers: {
          'AccessKey': env.BUNNY_ACCESS_KEY,
        },
      });

      logger.info('File deleted from Bunny Storage', { fileName });
    } catch (error) {
      logger.error('Failed to delete file from Bunny Storage', {
        fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async exists(fileName: string): Promise<boolean> {
    const url = `${this.storageUrl}/${fileName}`;

    try {
      const response = await axios({
        method: 'HEAD',
        url,
        headers: {
          'AccessKey': env.BUNNY_ACCESS_KEY,
        },
        validateStatus: (status) => status === 200 || status === 404,
      });

      return response.status === 200;
    } catch (error) {
      logger.error('Failed to check file existence', {
        fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async verifyCdnAccess(fileName: string): Promise<boolean> {
    const cdnUrl = `${this.cdnUrl}/${fileName}`;
    
    try {
      const response = await axios({
        method: 'HEAD',
        url: cdnUrl,
        timeout: 10000, // 10 second timeout
        validateStatus: (status) => status === 200 || status === 404,
      });

      const isAccessible = response.status === 200;
      
      logger.info('CDN access verification', {
        fileName,
        cdnUrl,
        accessible: isAccessible,
        status: response.status
      });

      return isAccessible;
    } catch (error) {
      logger.warn('CDN access verification failed', {
        fileName,
        cdnUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}