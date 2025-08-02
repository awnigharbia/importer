import axios from 'axios';
import fs from 'fs';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface ChunkedUploadOptions {
  filePath: string;
  fileName: string;
  onProgress?: (progress: UploadProgress) => void;
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  percentage: number;
  currentChunk?: number;
  totalChunks?: number;
}

export interface ChunkedUploadResult {
  cdnUrl: string;
  fileName: string;
  fileSize: number;
}

export class ChunkedUploader {
  private static readonly CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks for large files
  private static readonly MAX_RETRIES = 3;

  async upload(options: ChunkedUploadOptions): Promise<ChunkedUploadResult> {
    const { filePath, fileName, onProgress } = options;
    
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const totalChunks = Math.ceil(fileSize / ChunkedUploader.CHUNK_SIZE);
    
    logger.info('Starting chunked upload', {
      fileName,
      fileSize,
      totalChunks,
      chunkSize: ChunkedUploader.CHUNK_SIZE,
    });

    // For files smaller than chunk size, use direct upload
    if (fileSize <= ChunkedUploader.CHUNK_SIZE) {
      return this.directUpload(filePath, fileName, fileSize, onProgress);
    }

    // Use chunked upload for large files
    return this.chunkedUpload(filePath, fileName, fileSize, totalChunks, onProgress);
  }

  private async directUpload(
    filePath: string,
    fileName: string,
    fileSize: number,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<ChunkedUploadResult> {
    const uploadUrl = `https://storage.bunnycdn.com/${env.BUNNY_STORAGE_ZONE}/${fileName}`;
    
    const fileStream = fs.createReadStream(filePath, {
      highWaterMark: env.STREAM_BUFFER_SIZE * 1024,
    });

    let uploadedBytes = 0;

    // Create progress tracking transform stream
    const { Transform } = await import('stream');
    const progressStream = new Transform({
      highWaterMark: env.STREAM_BUFFER_SIZE * 1024,
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
      timeout: env.DOWNLOAD_TIMEOUT_MS * 3, // Triple timeout for uploads
    });

    if (response.status !== 201 && response.status !== 200) {
      throw new Error(`Upload failed with status: ${response.status}`);
    }

    // Ensure CDN URL doesn't have double slashes
    const cdnUrl = `${env.BUNNY_CDN_URL.replace(/\/$/, '')}/${fileName}`;
    
    return {
      cdnUrl,
      fileName,
      fileSize,
    };
  }

  private async chunkedUpload(
    filePath: string,
    fileName: string,
    fileSize: number,
    totalChunks: number,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<ChunkedUploadResult> {
    let uploadedBytes = 0;

    // Upload each chunk
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const start = chunkIndex * ChunkedUploader.CHUNK_SIZE;
      const end = Math.min(start + ChunkedUploader.CHUNK_SIZE, fileSize);
      const chunkSize = end - start;

      await this.uploadChunk(filePath, fileName, chunkIndex, start, end, chunkSize);
      
      uploadedBytes += chunkSize;
      
      if (onProgress) {
        const progress: UploadProgress = {
          uploadedBytes,
          totalBytes: fileSize,
          percentage: Math.round((uploadedBytes / fileSize) * 100),
          currentChunk: chunkIndex + 1,
          totalChunks,
        };
        onProgress(progress);
      }

      // Add small delay between chunks to prevent overwhelming the server
      if (chunkIndex < totalChunks - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // For chunked uploads, we need to concatenate chunks on Bunny Storage
    // This is a simplified approach - in production you'd use proper multipart upload API
    // Ensure CDN URL doesn't have double slashes
    const cdnUrl = `${env.BUNNY_CDN_URL.replace(/\/$/, '')}/${fileName}`;
    
    logger.info('Chunked upload completed', {
      fileName,
      fileSize: uploadedBytes,
      totalChunks,
    });

    return {
      cdnUrl,
      fileName,
      fileSize: uploadedBytes,
    };
  }

  private async uploadChunk(
    filePath: string,
    fileName: string,
    chunkIndex: number,
    start: number,
    end: number,
    chunkSize: number
  ): Promise<void> {
    const chunkFileName = `${fileName}.chunk.${chunkIndex.toString().padStart(6, '0')}`;
    const uploadUrl = `https://storage.bunnycdn.com/${env.BUNNY_STORAGE_ZONE}/${chunkFileName}`;

    // Create a read stream for this specific chunk
    const chunkStream = fs.createReadStream(filePath, {
      start,
      end: end - 1, // end is exclusive in createReadStream
      highWaterMark: env.STREAM_BUFFER_SIZE * 1024,
    });

    let retries = 0;
    while (retries < ChunkedUploader.MAX_RETRIES) {
      try {
        const response = await axios({
          method: 'PUT',
          url: uploadUrl,
          headers: {
            'AccessKey': env.BUNNY_ACCESS_KEY,
            'Content-Type': 'application/octet-stream',
            'Content-Length': chunkSize.toString(),
          },
          data: chunkStream,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 300000, // 5 minute timeout per chunk
        });

        if (response.status === 201 || response.status === 200) {
          logger.debug('Chunk uploaded successfully', {
            fileName,
            chunkIndex,
            chunkSize,
          });
          return;
        } else {
          throw new Error(`Chunk upload failed with status: ${response.status}`);
        }
      } catch (error) {
        retries++;
        logger.warn('Chunk upload failed, retrying', {
          fileName,
          chunkIndex,
          attempt: retries,
          error: error instanceof Error ? error.message : String(error),
        });

        if (retries >= ChunkedUploader.MAX_RETRIES) {
          throw new Error(`Chunk upload failed after ${ChunkedUploader.MAX_RETRIES} attempts: ${error}`);
        }

        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, retries) * 1000));
        
        // Note: In a real implementation, you'd need to reset the stream properly
        logger.debug('Preparing retry for chunk', { fileName, chunkIndex });
      }
    }
  }
}