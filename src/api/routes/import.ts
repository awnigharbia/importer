import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { addImportJob } from '../../queues/importQueue';
import { isGoogleDriveUrl } from '../../utils/googleDrive';
import { YouTubeDownloader } from '../../services/youtubeDownloader';

const router = Router();

const importSchema = z.object({
  url: z.string().url('Invalid URL format'),
  type: z.enum(['gdrive', 'direct', 'youtube']).optional(),
  fileName: z.string().optional(),
});

router.post('/import', async (req, res, next) => {
  try {
    const validation = importSchema.safeParse(req.body);
    
    if (!validation.success) {
      throw validation.error;
    }

    const { url, fileName } = validation.data;
    let { type } = validation.data;

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
    
    const job = await addImportJob({
      url,
      type,
      fileName: fileName || undefined,
      requestId,
    });

    res.status(201).json({
      success: true,
      data: {
        jobId: job.id,
        requestId,
        status: await job.getState(),
        url,
        type,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;