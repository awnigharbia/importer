import { Server, EVENTS } from '@tus/server';
import { FileStore } from '@tus/file-store';
import path from 'path';
import { nanoid } from 'nanoid';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { BunnyStorage } from './bunnyStorage';
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
    namingFunction: (req) => {
      const uploadMetadata = req.headers['upload-metadata'];
      let fileName = `upload-${nanoid()}.bin`;

      if (uploadMetadata) {
        const metadataObj = parseMetadata(uploadMetadata as string);
        if (metadataObj.filename) {
          fileName = Buffer.from(metadataObj.filename, 'base64').toString('utf8');
        }
      }

      return fileName;
    },
    onUploadCreate: async (req, res, upload) => {
      logger.info('TUS upload created', {
        uploadId: upload.id,
        size: upload.size,
      });
    },
    onUploadFinish: async (req, res, upload) => {
      logger.info('TUS upload finished', {
        uploadId: upload.id,
        size: upload.size,
      });

      try {
        // Get the file path from the upload
        const filePath = path.join(uploadDir, upload.id);
        
        // Create a job to upload to Bunny Storage
        const jobData = {
          url: filePath,
          type: 'direct' as const,
          fileName: upload.id,
          requestId: `tus-${upload.id}`,
        };

        await addImportJob(jobData);

        logger.info('TUS upload job created', {
          uploadId: upload.id,
          jobId: jobData.requestId,
        });
      } catch (error) {
        logger.error('Failed to create job for TUS upload', {
          uploadId: upload.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  // Add event listeners
  server.on(EVENTS.POST_CREATE, (req, res, upload) => {
    logger.debug('TUS POST_CREATE event', { uploadId: upload.id });
  });

  server.on(EVENTS.POST_RECEIVE, (req, res, upload) => {
    logger.debug('TUS POST_RECEIVE event', { 
      uploadId: upload.id,
      offset: upload.offset,
    });
  });

  server.on(EVENTS.POST_FINISH, (req, res, upload) => {
    logger.debug('TUS POST_FINISH event', { uploadId: upload.id });
  });

  server.on(EVENTS.POST_TERMINATE, (req, res, id) => {
    logger.info('TUS upload terminated', { uploadId: id });
  });

  return server;
}

function parseMetadata(metadata: string): Record<string, string> {
  const result: Record<string, string> = {};
  
  metadata.split(',').forEach((item) => {
    const [key, value] = item.trim().split(' ');
    if (key && value) {
      result[key] = value;
    }
  });

  return result;
}