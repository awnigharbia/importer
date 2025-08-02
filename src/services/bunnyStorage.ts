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
    this.cdnUrl = env.BUNNY_CDN_URL;
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

      const cdnUrl = `${this.cdnUrl}/${fileName}`;

      logger.info('File uploaded successfully to Bunny Storage', {
        fileName,
        fileSize,
        cdnUrl,
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
    const fileStream = fs.createReadStream(filePath);
    let uploadedBytes = 0;

    // Create a transform stream to track progress
    const { Transform } = await import('stream');
    const progressStream = new Transform({
      transform(chunk, _encoding, callback) {
        uploadedBytes += chunk.length;
        if (onProgress) {
          const progress: UploadProgress = {
            uploadedBytes,
            totalBytes: fileSize,
            percentage: Math.round((uploadedBytes / fileSize) * 100),
          };
          onProgress(progress);
        }
        callback(null, chunk);
      },
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
        timeout: env.DOWNLOAD_TIMEOUT_MS,
      });

      if (response.status !== 201 && response.status !== 200) {
        throw new Error(`Upload failed with status: ${response.status}`);
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          throw new Error(`Bunny Storage API error: ${error.response.status} - ${error.response.data}`);
        } else if (error.request) {
          throw new Error('No response from Bunny Storage API');
        }
      }
      throw error;
    } finally {
      fileStream.destroy();
      progressStream.destroy();
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
}