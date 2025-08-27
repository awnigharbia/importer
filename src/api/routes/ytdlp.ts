import { Router, Request, Response } from 'express';
import { ytdlpManager } from '../../services/ytdlpManager';
import { logger } from '../../utils/logger';

const router = Router();

/**
 * Get current yt-dlp status
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const versionInfo = await ytdlpManager.getVersionInfo();
    res.json(versionInfo);
  } catch (error) {
    logger.error('Failed to get yt-dlp status', { error });
    res.status(500).json({ error: 'Failed to get yt-dlp status' });
  }
});

/**
 * Trigger manual update
 */
router.post('/update', async (req: Request, res: Response) => {
  try {
    const { channel } = req.body;
    
    // Validate channel if provided
    if (channel && !['stable', 'nightly', 'master'].includes(channel)) {
      res.status(400).json({ 
        error: 'Invalid channel. Must be stable, nightly, or master' 
      });
      return;
    }

    logger.info('Manual yt-dlp update triggered', { channel });
    
    const updateResult = await ytdlpManager.update(channel);
    
    if (updateResult.success) {
      res.json({
        success: true,
        previousVersion: updateResult.previousVersion,
        newVersion: updateResult.newVersion,
        message: updateResult.previousVersion === updateResult.newVersion 
          ? 'Already up to date' 
          : 'Update completed successfully',
      });
    } else {
      res.status(500).json({
        success: false,
        error: updateResult.error || 'Update failed',
        previousVersion: updateResult.previousVersion,
      });
    }
  } catch (error) {
    logger.error('Failed to update yt-dlp', { error });
    res.status(500).json({ 
      success: false,
      error: 'Failed to update yt-dlp',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get available versions
 */
router.get('/versions', async (req: Request, res: Response) => {
  try {
    const channel = (req.query['channel'] as string) || 'stable';
    const limit = parseInt((req.query['limit'] as string) || '10', 10);
    
    if (!['stable', 'nightly', 'master'].includes(channel)) {
      res.status(400).json({ 
        error: 'Invalid channel. Must be stable, nightly, or master' 
      });
      return;
    }

    const versions = await ytdlpManager.getAvailableVersions(
      channel as 'stable' | 'nightly' | 'master',
      limit
    );
    
    res.json({
      channel,
      versions,
      total: versions.length,
    });
  } catch (error) {
    logger.error('Failed to get yt-dlp versions', { error });
    res.status(500).json({ error: 'Failed to get yt-dlp versions' });
  }
});

/**
 * Get current settings
 */
router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const settings = await ytdlpManager.getSettings();
    res.json(settings);
  } catch (error) {
    logger.error('Failed to get yt-dlp settings', { error });
    res.status(500).json({ error: 'Failed to get yt-dlp settings' });
  }
});

/**
 * Update settings
 */
router.put('/settings', async (req: Request, res: Response) => {
  try {
    const { channel, autoUpdate, updateFrequency } = req.body;
    
    // Validate input
    if (channel && !['stable', 'nightly', 'master'].includes(channel)) {
      res.status(400).json({ 
        error: 'Invalid channel. Must be stable, nightly, or master' 
      });
      return;
    }
    
    if (updateFrequency !== undefined && (updateFrequency < 1 || updateFrequency > 168)) {
      res.status(400).json({ 
        error: 'Update frequency must be between 1 and 168 hours' 
      });
      return;
    }

    await ytdlpManager.updateSettings({
      ...(channel && { channel }),
      ...(autoUpdate !== undefined && { autoUpdate }),
      ...(updateFrequency !== undefined && { updateFrequency }),
    });

    const updatedSettings = await ytdlpManager.getSettings();
    res.json(updatedSettings);
  } catch (error) {
    logger.error('Failed to update yt-dlp settings', { error });
    res.status(500).json({ error: 'Failed to update yt-dlp settings' });
  }
});

export default router;