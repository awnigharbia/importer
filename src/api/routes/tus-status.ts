import { Router } from 'express';
import { getRedisClient } from '../../config/redis';
import { AppError } from '../middleware/errorHandler';

const router = Router();
const redis = getRedisClient();

// Get TUS upload status by upload ID
router.get('/tus/status/:uploadId', async (req, res, next) => {
  try {
    const { uploadId } = req.params;
    
    // Get status from Redis
    const statusData = await redis.get(`tus:upload:${uploadId}`);
    
    if (!statusData) {
      // If no status found, upload might be completed or doesn't exist
      throw new AppError('Upload status not found', 404);
    }
    
    const status = JSON.parse(statusData);
    
    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    next(error);
  }
});

// Get all active TUS uploads
router.get('/tus/active', async (_req, res, next) => {
  try {
    // Get all TUS upload keys
    const keys = await redis.keys('tus:upload:*');
    
    if (keys.length === 0) {
      res.json({
        success: true,
        data: [],
      });
      return;
    }
    
    // Get all upload statuses
    const statuses = await Promise.all(
      keys.map(async (key) => {
        const data = await redis.get(key);
        return data ? JSON.parse(data) : null;
      })
    );
    
    // Filter out null values and only return uploading status
    const activeUploads = statuses
      .filter(status => status && status.status === 'uploading');
    
    res.json({
      success: true,
      data: activeUploads,
    });
  } catch (error) {
    next(error);
  }
});

export default router;