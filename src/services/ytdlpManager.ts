import { spawn } from 'child_process';
import { logger } from '../utils/logger';
import axios from 'axios';

export interface YtdlpVersion {
  current: string | null;
  latest: string | null;
  channel: 'stable' | 'nightly' | 'master';
  lastChecked: Date | null;
  needsUpdate: boolean;
}

export interface YtdlpUpdateResult {
  success: boolean;
  previousVersion: string | null;
  newVersion: string | null;
  error?: string;
}

export interface YtdlpSettings {
  channel: 'stable' | 'nightly' | 'master';
  autoUpdate: boolean;
  updateFrequency: number; // hours
  currentVersion?: string | null;
  lastChecked?: Date | null;
}

export class YtdlpManager {
  private static instance: YtdlpManager;
  private settings: YtdlpSettings | null = null;
  private isUpdating: boolean = false;
  private encodeAdminUrl: string;

  constructor() {
    this.encodeAdminUrl = process.env['ENCODE_ADMIN_URL'] || 'http://localhost:3000';
  }

  static getInstance(): YtdlpManager {
    if (!YtdlpManager.instance) {
      YtdlpManager.instance = new YtdlpManager();
    }
    return YtdlpManager.instance;
  }

  /**
   * Get settings from encode-admin
   */
  async getSettings(): Promise<YtdlpSettings> {
    try {
      const response = await axios.get(`${this.encodeAdminUrl}/api/settings`);
      const data = response.data;
      
      this.settings = {
        channel: data.ytdlpChannel || 'stable',
        autoUpdate: data.ytdlpAutoUpdate === 'enabled',
        updateFrequency: data.ytdlpUpdateFrequency || 24,
        currentVersion: data.ytdlpCurrentVersion,
        lastChecked: data.ytdlpLastChecked ? new Date(data.ytdlpLastChecked) : null,
      };
      
      return this.settings;
    } catch (error) {
      logger.error('Failed to get yt-dlp settings from encode-admin', { error });
      // Return default settings
      return {
        channel: 'stable',
        autoUpdate: true,
        updateFrequency: 24,
      };
    }
  }

  /**
   * Update settings in encode-admin
   */
  async updateSettings(updates: Partial<YtdlpSettings>): Promise<void> {
    try {
      const updateData: any = {};
      
      if (updates.channel !== undefined) {
        updateData.ytdlpChannel = updates.channel;
      }
      if (updates.autoUpdate !== undefined) {
        updateData.ytdlpAutoUpdate = updates.autoUpdate ? 'enabled' : 'disabled';
      }
      if (updates.updateFrequency !== undefined) {
        updateData.ytdlpUpdateFrequency = updates.updateFrequency;
      }
      if (updates.currentVersion !== undefined) {
        updateData.ytdlpCurrentVersion = updates.currentVersion;
      }
      if (updates.lastChecked !== undefined) {
        updateData.ytdlpLastChecked = updates.lastChecked;
      }
      
      await axios.put(`${this.encodeAdminUrl}/api/settings`, updateData);
      logger.info('Updated yt-dlp settings in encode-admin', { updates });
    } catch (error) {
      logger.error('Failed to update yt-dlp settings', { error });
    }
  }

  /**
   * Get current installed version of yt-dlp
   */
  async getCurrentVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      const process = spawn('yt-dlp', ['--version']);
      let output = '';

      process.stdout.on('data', (data) => {
        output += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          const version = output.trim();
          logger.debug('Current yt-dlp version', { version });
          resolve(version);
        } else {
          logger.warn('Failed to get yt-dlp version', { code });
          resolve(null);
        }
      });

      process.on('error', (error) => {
        logger.error('Error getting yt-dlp version', { error });
        resolve(null);
      });
    });
  }

  /**
   * Get latest version from GitHub API based on channel
   */
  async getLatestVersion(channel: 'stable' | 'nightly' | 'master'): Promise<string | null> {
    try {
      let apiUrl: string;
      
      switch (channel) {
        case 'stable':
          apiUrl = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
          break;
        case 'nightly':
          apiUrl = 'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest';
          break;
        case 'master':
          // For master, we need to get the latest commit
          apiUrl = 'https://api.github.com/repos/yt-dlp/yt-dlp/commits/master';
          break;
        default:
          apiUrl = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
      }

      const response = await axios.get(apiUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'yt-dlp-manager',
        },
        timeout: 10000,
      });

      if (channel === 'master') {
        // For master channel, version is the commit SHA
        return response.data.sha?.substring(0, 7) || null;
      } else {
        // For stable and nightly, use tag name
        return response.data.tag_name || null;
      }
    } catch (error) {
      logger.error('Failed to get latest yt-dlp version from GitHub', { channel, error });
      return null;
    }
  }

  /**
   * Check if update is needed based on settings and time
   */
  async shouldUpdate(): Promise<boolean> {
    const settings = await this.getSettings();
    
    if (!settings.autoUpdate) {
      logger.debug('Auto-update is disabled');
      return false;
    }

    // Check if we're already updating
    if (this.isUpdating) {
      logger.debug('Update already in progress');
      return false;
    }

    // Check update frequency
    if (settings.lastChecked) {
      const hoursSinceLastCheck = (Date.now() - new Date(settings.lastChecked).getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastCheck < settings.updateFrequency) {
        logger.debug('Not time for update check yet', { 
          hoursSinceLastCheck, 
          updateFrequency: settings.updateFrequency 
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Perform yt-dlp update
   */
  async update(channel?: 'stable' | 'nightly' | 'master'): Promise<YtdlpUpdateResult> {
    if (this.isUpdating) {
      return {
        success: false,
        previousVersion: null,
        newVersion: null,
        error: 'Update already in progress',
      };
    }

    this.isUpdating = true;

    try {
      const settings = await this.getSettings();
      const updateChannel = channel || settings.channel;
      
      // Get current version before update
      const previousVersion = await this.getCurrentVersion();
      
      logger.info('Starting yt-dlp update', { 
        channel: updateChannel, 
        previousVersion 
      });

      // Perform update
      const updateResult = await this.performUpdate(updateChannel);
      
      if (updateResult.success) {
        // Get new version after update
        const newVersion = await this.getCurrentVersion();
        
        // Update settings with new version and last checked time
        await this.updateSettings({
          currentVersion: newVersion,
          lastChecked: new Date(),
        });

        logger.info('yt-dlp updated successfully', { 
          previousVersion, 
          newVersion,
          channel: updateChannel 
        });

        return {
          success: true,
          previousVersion,
          newVersion,
        };
      } else {
        logger.error('yt-dlp update failed', { 
          error: updateResult.error,
          channel: updateChannel 
        });
        
        // Update last checked time even if update failed
        await this.updateSettings({
          lastChecked: new Date(),
        });

        return {
          success: false,
          previousVersion,
          newVersion: null,
          error: updateResult.error || 'Unknown error',
        };
      }
    } catch (error) {
      logger.error('Unexpected error during yt-dlp update', { error });
      return {
        success: false,
        previousVersion: null,
        newVersion: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.isUpdating = false;
    }
  }

  /**
   * Perform the actual update using yt-dlp command
   */
  private performUpdate(channel: 'stable' | 'nightly' | 'master'): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const args = ['-U'];
      
      // Add channel-specific update argument
      if (channel !== 'stable') {
        args.push('--update-to', channel);
      }

      const process = spawn('yt-dlp', args);
      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
        logger.debug('yt-dlp update output', { data: data.toString() });
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
        logger.debug('yt-dlp update error', { data: data.toString() });
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          const error = stderr || stdout || `Process exited with code ${code}`;
          resolve({ success: false, error });
        }
      });

      process.on('error', (error) => {
        logger.error('Failed to start yt-dlp update process', { error });
        resolve({ success: false, error: error.message });
      });
    });
  }

  /**
   * Check for updates and perform if needed
   */
  async checkAndUpdate(): Promise<YtdlpUpdateResult | null> {
    if (!await this.shouldUpdate()) {
      return null;
    }

    const settings = await this.getSettings();
    const currentVersion = await this.getCurrentVersion();
    const latestVersion = await this.getLatestVersion(settings.channel);

    logger.info('Checking for yt-dlp updates', {
      currentVersion,
      latestVersion,
      channel: settings.channel,
    });

    // If versions are different or we can't determine them, attempt update
    if (!currentVersion || !latestVersion || currentVersion !== latestVersion) {
      return await this.update(settings.channel);
    }

    // Update last checked time even if no update needed
    await this.updateSettings({
      lastChecked: new Date(),
    });

    logger.info('yt-dlp is up to date', { version: currentVersion });
    return {
      success: true,
      previousVersion: currentVersion,
      newVersion: currentVersion,
    };
  }

  /**
   * Get version information
   */
  async getVersionInfo(): Promise<YtdlpVersion> {
    const settings = await this.getSettings();
    const current = await this.getCurrentVersion();
    const latest = await this.getLatestVersion(settings.channel);
    
    const needsUpdate = !current || !latest || current !== latest;

    return {
      current,
      latest,
      channel: settings.channel,
      lastChecked: settings.lastChecked || null,
      needsUpdate,
    };
  }

  /**
   * List available versions for a channel
   */
  async getAvailableVersions(channel: 'stable' | 'nightly' | 'master', limit: number = 10): Promise<string[]> {
    try {
      let apiUrl: string;
      
      switch (channel) {
        case 'stable':
          apiUrl = `https://api.github.com/repos/yt-dlp/yt-dlp/releases?per_page=${limit}`;
          break;
        case 'nightly':
          apiUrl = `https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases?per_page=${limit}`;
          break;
        case 'master':
          apiUrl = `https://api.github.com/repos/yt-dlp/yt-dlp/commits?per_page=${limit}`;
          break;
        default:
          return [];
      }

      const response = await axios.get(apiUrl, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'yt-dlp-manager',
        },
        timeout: 10000,
      });

      if (channel === 'master') {
        return response.data.map((commit: any) => commit.sha?.substring(0, 7) || '').filter(Boolean);
      } else {
        return response.data.map((release: any) => release.tag_name || '').filter(Boolean);
      }
    } catch (error) {
      logger.error('Failed to get available versions', { channel, error });
      return [];
    }
  }
}

export const ytdlpManager = YtdlpManager.getInstance();