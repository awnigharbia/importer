import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { logger } from '../utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface YouTubeDownloadOptions {
  videoId: string;
  outputPath: string;
  onProgress?: (progress: YouTubeDownloadProgress) => void;
}

export interface YouTubeDownloadProgress {
  stage: 'downloading' | 'cleanup';
  percentage: number;
  message: string;
}

export interface YouTubeDownloadResult {
  filePath: string;
  fileName: string;
  fileSize: number;
  videoId: string;
}

// Proxy configurations for downloads
const proxies = [
  "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10001",
  "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10002",
  "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10003",
  "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10004",
  "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10005",
  "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10006",
  "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10007",
  "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10008",
  "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10009",
  "http://spu1x10ji0:18+1ayDlNlwuuJl0kX@isp.decodo.com:10010",
];

export class YouTubeDownloader {
  private tempDir: string;

  constructor() {
    this.tempDir = path.resolve('./temp');
    this.ensureTempDir();
  }

  private ensureTempDir(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async download(options: YouTubeDownloadOptions): Promise<YouTubeDownloadResult> {
    const { videoId, outputPath, onProgress } = options;
    
    logger.info('Starting YouTube video download with yt-dlp', { videoId });

    // Ensure output directory exists
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }

    const randomString = nanoid(8);
    const outputTemplate = path.join(outputPath, `${videoId}-${randomString}.%(ext)s`);
    const youtubeLink = `https://www.youtube.com/watch?v=${videoId}`;

    // Clean up any existing files for this video ID before starting
    this.cleanupPartialDownloads(videoId, outputPath);

    // Try each proxy until one works
    for (let i = 0; i < proxies.length; i++) {
      const proxy = proxies[i];
      
      try {
        onProgress?.({ 
          stage: 'downloading', 
          percentage: 10 + (i * 15), 
          message: `Attempting download with proxy ${i + 1}/${proxies.length}...` 
        });

        logger.info(`Attempting download with proxy ${i + 1}/${proxies.length}`, { proxy, videoId });

        // Use the same yt-dlp command format as upload-testcopy
        const command = `yt-dlp --proxy "${proxy}" -f "bv*[height<=1080][height>=720]+ba[format_id*=drc][abr>=128]/bv*[height<=1080][height>=720]+ba[abr>=128]/bv*[height<=1080]+ba*[abr>=128]" -S "height,tbr,+hdr" -o "${outputTemplate}" ${youtubeLink} -N 32`;
        
        // Set timeout for download (2 minutes)
        const timeoutMs = 2 * 60 * 1000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const { stdout } = await execAsync(command);
          clearTimeout(timeoutId);
          
          logger.info(`yt-dlp download completed with proxy ${i + 1}`, { stdout, videoId });

          onProgress?.({ 
            stage: 'downloading', 
            percentage: 90, 
            message: 'Download completed, verifying file...' 
          });

          // Find the downloaded file
          const files = fs.readdirSync(outputPath);
          const videoFile = files.find(file => 
            file.startsWith(`${videoId}-${randomString}`) && 
            !file.endsWith('.part') &&
            !file.endsWith('.ytdl') &&
            !file.endsWith('.temp') &&
            !file.includes('part-Frag') &&
            !file.includes('.part-')
          );

          if (!videoFile) {
            throw new Error('Downloaded file not found');
          }

          const filePath = path.join(outputPath, videoFile);
          const stats = fs.statSync(filePath);

          // Verify file size is reasonable (at least 5MB for video)
          if (stats.size < 5 * 1024 * 1024) {
            fs.unlinkSync(filePath);
            throw new Error(`Downloaded file too small: ${stats.size} bytes`);
          }

          onProgress?.({ 
            stage: 'cleanup', 
            percentage: 100, 
            message: 'Download completed successfully' 
          });

          logger.info('YouTube download completed successfully', { 
            videoId, 
            fileName: videoFile, 
            fileSize: stats.size 
          });

          return {
            filePath,
            fileName: videoFile,
            fileSize: stats.size,
            videoId
          };

        } catch (error) {
          clearTimeout(timeoutId);
          logger.warn(`Download failed with proxy ${i + 1}`, { proxy, error, videoId });
          this.cleanupPartialDownloads(videoId, outputPath);
          
          if (i === proxies.length - 1) {
            throw new Error(`All proxies failed for video ${videoId}: ${error}`);
          }
        }

      } catch (error) {
        logger.warn(`Error with proxy ${i + 1}`, { proxy, error, videoId });
        this.cleanupPartialDownloads(videoId, outputPath);
        
        if (i === proxies.length - 1) {
          throw new Error(`Failed to download video ${videoId} after trying all proxies`);
        }
      }
    }

    throw new Error(`Failed to download video ${videoId} after trying all methods`);
  }

  private cleanupPartialDownloads(videoId: string, outputPath: string): void {
    try {
      if (!fs.existsSync(outputPath)) {
        return;
      }

      const files = fs.readdirSync(outputPath);

      // Clean up all types of partial/temporary files
      const partialFiles = files.filter(file =>
        file.startsWith(videoId) &&
        (file.endsWith('.part') ||
          file.endsWith('.ytdl') ||
          file.endsWith('.temp') ||
          file.includes('part-Frag') ||
          file.includes('.part-') ||
          file.endsWith('.f270.mp4') ||
          file.endsWith('.f137.mp4') ||
          file.endsWith('.m4a'))
      );

      for (const file of partialFiles) {
        const filePath = path.join(outputPath, file);
        fs.unlinkSync(filePath);
        logger.debug('Removed partial download file', { file, videoId });
      }

      // Also clean up any suspiciously small files that might be corrupted
      const allVideoFiles = files.filter(file =>
        file.startsWith(videoId) &&
        !file.endsWith('.part') &&
        !file.endsWith('.ytdl') &&
        !file.endsWith('.temp') &&
        !file.includes('part-Frag') &&
        !file.includes('.part-')
      );

      for (const file of allVideoFiles) {
        const filePath = path.join(outputPath, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.size < 5 * 1024 * 1024) { // Less than 5MB
            fs.unlinkSync(filePath);
            logger.debug('Removed suspiciously small file', { 
              file, 
              size: stats.size, 
              videoId 
            });
          }
        } catch (error) {
          // File might already be deleted, ignore
        }
      }
    } catch (error) {
      logger.warn('Error cleaning up partial downloads', { error, videoId });
    }
  }

  // Utility method to extract video ID from YouTube URL
  static extractVideoId(url: string): string | null {
    const patterns = [
      /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/ // Direct video ID
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  // Utility method to validate YouTube URL
  static isYouTubeUrl(url: string): boolean {
    return this.extractVideoId(url) !== null;
  }
}