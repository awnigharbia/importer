import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { logger } from '../utils/logger';
import { spawn } from 'child_process';
import { proxyService } from './proxyService';
import { ytdlpManager } from './ytdlpManager';

import { ProxyLog } from '../queues/importQueue';

export interface YouTubeDownloadOptions {
  videoId: string;
  outputPath: string;
  onProgress?: (progress: YouTubeDownloadProgress) => void;
  onProxyLog?: (log: ProxyLog) => void;
}

export interface YouTubeDownloadProgress {
  stage: 'downloading' | 'cleanup';
  percentage: number;
  message: string;
  selectedQuality?: {
    resolution?: string;
    fps?: number;
    videoCodec?: string;
    audioCodec?: string;
    bitrate?: string;
    format?: string;
  };
}

export interface YouTubeDownloadResult {
  filePath: string;
  fileName: string;
  fileSize: number;
  videoId: string;
  selectedQuality?: {
    resolution?: string;
    fps?: number;
    videoCodec?: string;
    audioCodec?: string;
    bitrate?: string;
    format?: string;
  };
}


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
    const { videoId, outputPath, onProgress, onProxyLog } = options;
    const proxyLogs: ProxyLog[] = [];

    logger.info('Starting YouTube video download with yt-dlp', { videoId });

    // Check for yt-dlp updates before download
    try {
      const updateResult = await ytdlpManager.checkAndUpdate();
      if (updateResult) {
        if (updateResult.success && updateResult.previousVersion !== updateResult.newVersion) {
          logger.info('yt-dlp was updated before download', {
            previousVersion: updateResult.previousVersion,
            newVersion: updateResult.newVersion,
          });
        } else if (!updateResult.success) {
          logger.warn('yt-dlp update check failed, continuing with current version', {
            error: updateResult.error,
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to check for yt-dlp updates, continuing with current version', { error });
    }

    // Ensure output directory exists
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }

    const randomString = nanoid(8);
    const outputTemplate = path.join(outputPath, `${videoId}-${randomString}.%(ext)s`);
    const youtubeLink = `https://www.youtube.com/watch?v=${videoId}`;

    // Clean up any existing files for this video ID before starting
    this.cleanupPartialDownloads(videoId, outputPath);

    // Get proxies from proxy service
    const proxies = await proxyService.getProxies();

    if (proxies.length === 0) {
      throw new Error('No proxies available for download');
    }

    // Try each proxy until one works
    for (let i = 0; i < proxies.length; i++) {
      const proxy = proxies[i]!;
      const startTime = Date.now();
      const proxyLog: ProxyLog = {
        proxyUrl: proxy,
        attemptNumber: i + 1,
        startTime: new Date().toISOString(),
        success: false
      };

      try {
        onProgress?.({
          stage: 'downloading',
          percentage: 10 + (i * 15),
          message: `Attempting download with proxy ${i + 1}/${proxies.length}...`
        });

        logger.info(`Attempting download with proxy ${i + 1}/${proxies.length}`, { proxy, videoId });
        
        // Pre-fetch format information for better tracking
        let preSelectedQuality: any = {};
        try {
          const formatInfoArgs = [
            '--proxy', proxy,
            '-f', 'bv*[height<=1080][vcodec!*=vp09.02][vcodec!*=av01][dynamic_range!=HDR][dynamic_range!=HDR10][dynamic_range!=HDR12]+ba/b[height<=1080][dynamic_range!=HDR]',
            '--print', '%(format_id)s|%(resolution)s|%(fps)s|%(vcodec)s|%(acodec)s|%(format_note)s',
            youtubeLink,
          ];
          
          const { stdout: formatInfo } = await new Promise<{ stdout: string; stderr: string }>((resolve) => {
            const child = spawn('yt-dlp', formatInfoArgs);
            let stdout = '';
            let stderr = '';
            
            child.stdout.on('data', (data) => stdout += data.toString());
            child.stderr.on('data', (data) => stderr += data.toString());
            
            child.on('close', () => resolve({ stdout: stdout.trim(), stderr }));
            
            // Timeout after 5 seconds
            setTimeout(() => {
              child.kill();
              resolve({ stdout: stdout.trim(), stderr: 'Timeout' });
            }, 5000);
          });
          
          if (formatInfo) {
            const parts = formatInfo.split('|');
            if (parts.length >= 5) {
              preSelectedQuality = {
                format: parts[0] || undefined,
                resolution: parts[1] !== 'NA' ? parts[1] : undefined,
                fps: parts[2] !== 'NA' && parts[2] ? parseInt(parts[2]) : undefined,
                videoCodec: parts[3] !== 'NA' ? parts[3] : undefined,
                audioCodec: parts[4] !== 'NA' ? parts[4] : undefined,
              };
              logger.debug('Pre-fetched format info', { preSelectedQuality, videoId });
            }
          }
        } catch (error) {
          logger.debug('Failed to pre-fetch format info, continuing with download', { error, videoId });
        }

        // Use spawn instead of exec to handle large downloads
        const args: string[] = [
          '--proxy', proxy,
          '-f', 'bv*[height<=1080][vcodec!*=vp09.02][vcodec!*=av01][dynamic_range!=HDR][dynamic_range!=HDR10][dynamic_range!=HDR12]+ba/b[height<=1080][dynamic_range!=HDR]',
          '-S', 'height,tbr,+hdr',
          '-o', outputTemplate,
          youtubeLink,
          '-N', '28',
          '--progress',
          '--newline'
        ];

        // Set timeout for download (30 minutes for large videos)
        const timeoutMs = 30 * 60 * 1000;

        const downloadResult = await this.runYtDlpWithSpawn(args, timeoutMs, onProgress, i, proxies.length, preSelectedQuality);

        if (downloadResult.success) {
          // Store the selected quality info
          const selectedQuality = downloadResult.selectedQuality || {};
          const responseTime = Date.now() - startTime;
          logger.info(`yt-dlp download completed with proxy ${i + 1}`, { videoId, responseTime });

          // Update proxy log with success
          proxyLog.success = true;
          proxyLog.endTime = new Date().toISOString();
          proxyLog.responseTime = responseTime;
          proxyLogs.push(proxyLog);
          onProxyLog?.(proxyLog);

          // Report successful proxy usage
          await proxyService.reportProxyResult(proxy, true, responseTime);

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
            videoId,
            selectedQuality: Object.keys(selectedQuality).length > 0 ? selectedQuality : undefined
          };

        } else {
          logger.warn(`Download failed with proxy ${i + 1}`, { proxy, error: downloadResult.error, videoId });

          // Update proxy log with failure
          proxyLog.success = false;
          proxyLog.endTime = new Date().toISOString();
          proxyLog.responseTime = Date.now() - startTime;
          proxyLog.errorMessage = downloadResult.error || 'Download failed';
          proxyLogs.push(proxyLog);
          onProxyLog?.(proxyLog);

          this.cleanupPartialDownloads(videoId, outputPath);

          // Report failed proxy usage
          await proxyService.reportProxyResult(proxy, false);

          if (i === proxies.length - 1) {
            throw new Error(`All proxies failed for video ${videoId}: ${downloadResult.error}`);
          }
        }

      } catch (error) {
        logger.warn(`Error with proxy ${i + 1}`, { proxy, error, videoId });

        // Update proxy log with error
        proxyLog.success = false;
        proxyLog.endTime = new Date().toISOString();
        proxyLog.responseTime = Date.now() - startTime;
        proxyLog.errorMessage = error instanceof Error ? error.message : String(error);
        proxyLogs.push(proxyLog);
        onProxyLog?.(proxyLog);

        this.cleanupPartialDownloads(videoId, outputPath);

        // Report failed proxy usage
        await proxyService.reportProxyResult(proxy, false);

        if (i === proxies.length - 1) {
          throw new Error(`Failed to download video ${videoId} after trying all proxies`);
        }
      }
    }

    throw new Error(`Failed to download video ${videoId} after trying all methods`);
  }

  private async runYtDlpWithSpawn(
    args: string[],
    timeoutMs: number,
    onProgress: ((progress: YouTubeDownloadProgress) => void) | undefined,
    proxyIndex: number,
    totalProxies: number,
    preSelectedQuality?: any
  ): Promise<{ success: boolean; error?: string; selectedQuality?: any }> {
    return new Promise((resolve) => {
      const ytDlp = spawn('yt-dlp', args);
      let stdout = '';
      let stderr = '';
      let lastProgress = 0;
      let selectedQuality: any = preSelectedQuality || {};
      // Set timeout
      const timeoutId = setTimeout(() => {
        ytDlp.kill('SIGTERM');
        resolve({ success: false, error: 'Download timeout after 30 minutes' });
      }, timeoutMs);

      // Handle stdout
      ytDlp.stdout.on('data', (data) => {
        const output = data.toString();
        stdout += output;

        // Parse progress from yt-dlp output
        const progressMatch = output.match(/(\d+\.\d+)%/);
        if (progressMatch) {
          const percentage = parseFloat(progressMatch[1]);
          if (percentage > lastProgress) {
            lastProgress = percentage;
            const adjustedProgress = 10 + (proxyIndex * 15 / totalProxies) + (percentage * 0.75);

            onProgress?.({
              stage: 'downloading',
              percentage: Math.min(adjustedProgress, 89),
              message: `Downloading: ${percentage.toFixed(1)}%`,
              ...(Object.keys(selectedQuality).length > 0 ? { selectedQuality } : {})
            });
          }
        }

        // Parse quality information from yt-dlp output
        // NEW: Look for format IDs in the new output format
        if (output.includes('[info]') && output.includes('Downloading') && output.includes('format(s):')) {
          const formatMatch = output.match(/Downloading \d+ format\(s\): ([\d\+]+)/);
          if (formatMatch) {
            selectedQuality.format = formatMatch[1];
            logger.debug('Captured format IDs', { format: formatMatch[1] });
          }
        }
        
        // Parse resolution from download progress lines
        if (output.includes('[download]') && output.includes('Destination:')) {
          // Try to extract resolution from filename or path
          const resMatch = output.match(/(\d{3,4})x(\d{3,4})/);
          if (resMatch) {
            selectedQuality.resolution = `${resMatch[2]}p`;
          }
        }
        
        // Parse from merger output (when merging video + audio)
        if (output.includes('[Merger]') && output.includes('Merging formats into')) {
          const resMatch = output.match(/(\d{3,4})x(\d{3,4})/);
          if (resMatch) {
            selectedQuality.resolution = `${resMatch[2]}p`;
          }
        }
        
        // Try to parse format details from any line containing resolution
        if (output.match(/\d{3,4}x\d{3,4}/)) {
          const resMatch = output.match(/(\d{3,4})x(\d{3,4})/);
          if (resMatch && !selectedQuality.resolution) {
            selectedQuality.resolution = `${resMatch[2]}p`;
          }
          
          // Also try to get FPS if it appears nearby
          const fpsMatch = output.match(/(\d+)fps/i);
          if (fpsMatch && !selectedQuality.fps) {
            selectedQuality.fps = parseInt(fpsMatch[1]);
          }
        }
        
        // Parse codec information if available
        if (output.includes('vp09') || output.includes('avc1') || output.includes('av01')) {
          const vcodecMatch = output.match(/(vp09|avc1|av01)[\.\d]*/i);
          if (vcodecMatch && !selectedQuality.videoCodec) {
            selectedQuality.videoCodec = vcodecMatch[0];
          }
        }
        
        if (output.includes('opus') || output.includes('mp4a') || output.includes('aac')) {
          const acodecMatch = output.match(/(opus|mp4a|aac)[\.\d]*/i);
          if (acodecMatch && !selectedQuality.audioCodec) {
            selectedQuality.audioCodec = acodecMatch[0];
          }
        }
        
        // Log progress lines for debugging
        if (output.includes('%') || output.includes('Downloading')) {
          logger.debug('yt-dlp progress', { output: output.trim() });
        }
      });

      // Handle stderr
      ytDlp.stderr.on('data', (data) => {
        const error = data.toString();
        stderr += error;
        logger.debug('yt-dlp stderr', { error: error.trim() });
      });

      // Handle process exit
      ytDlp.on('close', (code) => {
        clearTimeout(timeoutId);

        if (code === 0) {
          logger.info('yt-dlp process completed successfully', { stdout: stdout.slice(-500), selectedQuality });
          resolve({ success: true, selectedQuality });
        } else {
          const errorMessage = stderr || stdout || `Process exited with code ${code}`;
          logger.error('yt-dlp process failed', { code, stderr, stdout: stdout.slice(-500) });
          resolve({ success: false, error: errorMessage });
        }
      });

      // Handle process errors
      ytDlp.on('error', (error) => {
        clearTimeout(timeoutId);
        logger.error('Failed to start yt-dlp process', { error });
        resolve({ success: false, error: error.message });
      });
    });
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