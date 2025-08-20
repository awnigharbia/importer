import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { addImportJob } from '../../queues/importQueue';
import { isGoogleDriveUrl } from '../../utils/googleDrive';
import { YouTubeDownloader } from '../../services/youtubeDownloader';
import { logger } from '../../utils/logger';

const router = Router();

const importSchema = z.object({
  url: z.string().url('Invalid URL format'),
  type: z.enum(['gdrive', 'direct', 'youtube']).optional(),
  fileName: z.string().optional(),
  videoId: z.string().optional(),
});

router.post('/import', async (req, res, next) => {
  try {
    const validation = importSchema.safeParse(req.body);
    
    if (!validation.success) {
      throw validation.error;
    }

    const { url, fileName, videoId: bodyVideoId } = validation.data;
    let { type } = validation.data;

    // Check for video-id in headers (similar to TUS upload)
    let videoId = bodyVideoId;
    if (!videoId && req.headers['video-id']) {
      videoId = req.headers['video-id'] as string;
    }

    // Auto-detect type if not provided
    if (!type) {
      if (isGoogleDriveUrl(url)) {
        type = 'gdrive';
      } else if (YouTubeDownloader.isYouTubeUrl(url)) {
        type = 'youtube';
      } else {
        type = 'direct';
      }
    }

    const requestId = nanoid();
    
    // Log if video ID is provided
    if (videoId) {
      logger.info('Import request with video ID', {
        requestId,
        videoId,
        type,
        url,
      });
    }
    
    const job = await addImportJob({
      url,
      type,
      fileName: fileName || undefined,
      requestId,
      ...(videoId && { videoId }),
    });

    res.status(201).json({
      success: true,
      data: {
        jobId: job.id,
        requestId,
        status: await job.getState(),
        url,
        type,
        ...(videoId && { videoId }),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;