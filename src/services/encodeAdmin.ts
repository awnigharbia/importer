import axios from 'axios';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export interface CreateVideoData {
  name: string;
  sourceLink: string;
}

export interface UpdateVideoSourceData {
  sourceLink: string;
}

export interface VideoResponse {
  id: string;
  name: string;
  sourceLink: string;
}

export interface ReportImportFailureData {
  error: string;
  sourceUrl?: string;
  retryCount?: number;
}

export class EncodeAdminService {
  private apiUrl: string;
  private apiKey: string;

  constructor() {
    this.apiUrl = env.ENCODE_ADMIN_API_URL || 'https://encode-admin.fly.dev/api';
    this.apiKey = env.ENCODE_ADMIN_API_KEY || 'e9aaae3945ba3937b04feeb14de0c407';
  }

  async createVideo(data: CreateVideoData): Promise<VideoResponse> {
    try {
      const response = await axios({
        method: 'POST',
        url: `${this.apiUrl}/user/videos`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        data,
      });

      logger.info('Created video in encode-admin', {
        videoId: response.data.id,
        name: data.name,
      });

      return response.data;
    } catch (error) {
      logger.error('Failed to create video in encode-admin', {
        error: error instanceof Error ? error.message : String(error),
        data,
      });
      throw error;
    }
  }

  async updateVideoSourceLink(videoId: string, sourceLink: string): Promise<VideoResponse> {
    try {
      const response = await axios({
        method: 'PUT',
        url: `${this.apiUrl}/user/videos/${videoId}/source-link`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        data: { sourceLink },
      });

      logger.info('Updated video source link in encode-admin', {
        videoId,
        sourceLink,
      });

      return response.data;
    } catch (error) {
      logger.error('Failed to update video source link in encode-admin', {
        videoId,
        sourceLink,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async reportImportFailure(videoId: string, data: ReportImportFailureData): Promise<void> {
    try {
      await axios({
        method: 'POST',
        url: `${this.apiUrl}/user/videos/${videoId}/import-failed`,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        data,
      });

      logger.info('Reported import failure to encode-admin', {
        videoId,
        error: data.error,
        retryCount: data.retryCount,
      });
    } catch (error) {
      logger.error('Failed to report import failure to encode-admin', {
        videoId,
        data,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - we don't want to fail the cleanup because webhook failed
    }
  }
}