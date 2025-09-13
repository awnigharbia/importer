import { Server, EVENTS } from '@tus/server';
import { FileStore } from '@tus/file-store';
import path from 'path';
import { nanoid } from 'nanoid';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { addImportJob } from '../queues/importQueue';

export function createTusServer(): Server {
  const uploadDir = path.join(env.TEMP_DIR, 'tus-uploads');

  const datastore = new FileStore({
    directory: uploadDir,
  });

  const server = new Server({
    path: env.TUS_PATH,
    datastore,
    maxSize: env.MAX_FILE_SIZE_MB * 1024 * 1024, // Set max file size
    respectForwardedHeaders: true,
    namingFunction: (_req) => {
      // Always use a safe ID for the actual file storage
      // This avoids filesystem issues with Unicode/Arabic characters
      const safeFileName = `upload-${nanoid()}.bin`;
      
      // The original filename (including Arabic) will be preserved in metadata
      // and used when uploading to Bunny Storage
      return safeFileName;
    },
    onUploadCreate: async (_req, _res, upload) => {
      logger.info('TUS upload created', {
        uploadId: upload.id,
        size: upload.size,
      });
      return { res: _res };
    },
    onUploadFinish: async (_req, _res, upload) => {
      logger.info('TUS upload finished', {
        uploadId: upload.id,
        size: upload.size,
      });

      try {
        // Get the file path from the upload
        const filePath = path.join(uploadDir, upload.id);

        // Log upload object to debug what's available
        logger.info('Upload object in onUploadFinish', {
          uploadId: upload.id,
          metadata: upload.metadata,
          size: upload.size,
        });

        let videoId: string | undefined;
        let originalFileName: string | undefined;
        let apiKey: string | undefined;
        
        if (upload.metadata) {
          // Extract video ID if present
          if (upload.metadata['video-id']) {
            // The video ID is already decoded in the metadata object, no need to decode from base64
            videoId = upload.metadata['video-id'];
            logger.info('Extracted video ID from upload metadata', {
              uploadId: upload.id,
              videoId,
              rawVideoId: upload.metadata['video-id'],
            });
          } else {
            logger.warn('No video-id found in upload metadata', {
              uploadId: upload.id,
              availableMetadata: Object.keys(upload.metadata || {}),
            });
          }
          
          // Extract API key if present for encode-admin authentication
          if (upload.metadata['api-key']) {
            apiKey = upload.metadata['api-key'];
            logger.info('Extracted API key from upload metadata', {
              uploadId: upload.id,
              hasApiKey: true,
              apiKeyLength: apiKey.length,
            });
          }
          
          // Extract original filename if present (including Arabic characters)
          if (upload.metadata['filename']) {
            originalFileName = upload.metadata['filename'];
            logger.info('Extracted original filename from upload metadata', {
              uploadId: upload.id,
              originalFileName,
            });
          }
        }

        // Use original filename if available, otherwise use the upload ID
        const uploadFileName = originalFileName || upload.id;

        // Create a job to upload to Bunny Storage
        const jobData = {
          url: filePath,
          type: 'local' as const,
          fileName: uploadFileName,
          requestId: `tus-${upload.id}-${Date.now()}`,
          ...(videoId && { videoId }),
          ...(apiKey && { apiKey }),
        };

        await addImportJob(jobData);

        logger.info('TUS upload job created', {
          uploadId: upload.id,
          jobId: jobData.requestId,
          videoId,
        });
      } catch (error) {
        logger.error('Failed to create job for TUS upload', {
          uploadId: upload.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { res: _res };
    },
  });

  // Add event listeners
  server.on(EVENTS.POST_CREATE, (_req, _res, upload) => {
    logger.debug('TUS POST_CREATE event', { uploadId: upload.id });
  });

  server.on(EVENTS.POST_RECEIVE, (_req, _res, upload) => {
    logger.debug('TUS POST_RECEIVE event', {
      uploadId: upload.id,
      offset: upload.offset,
    });
  });

  server.on(EVENTS.POST_FINISH, (_req, _res, upload) => {
    logger.debug('TUS POST_FINISH event', { uploadId: upload.id });
  });

  server.on(EVENTS.POST_TERMINATE, (_req, _res, id) => {
    logger.info('TUS upload terminated', { uploadId: id });
  });

  return server;
}

