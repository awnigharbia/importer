import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { parseGoogleDriveUrl } from '../utils/googleDrive';
import { logger } from '../utils/logger';

export interface GoogleDriveAuth {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface DownloadOptions {
  outputPath?: string;
  fileName?: string;
  maxSize?: number;
}

export interface DownloadResult {
  filePath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export class GoogleDriveDownloader {
  private auth: OAuth2Client;
  private drive: any;

  constructor(authConfig: GoogleDriveAuth) {
    this.auth = new OAuth2Client(
      authConfig.clientId,
      authConfig.clientSecret,
      'urn:ietf:wg:oauth:2.0:oob'
    );

    this.auth.setCredentials({
      refresh_token: authConfig.refreshToken,
    });

    this.drive = google.drive({ version: 'v3', auth: this.auth });
  }

  async downloadFile(
    fileIdOrUrl: string,
    options: DownloadOptions = {}
  ): Promise<DownloadResult> {
    try {
      let fileId: string;

      if (fileIdOrUrl.includes('drive.google.com')) {
        const driveInfo = parseGoogleDriveUrl(fileIdOrUrl);
        if (!driveInfo) {
          throw new Error('Invalid Google Drive URL');
        }
        fileId = driveInfo.fileId;
      } else {
        fileId = fileIdOrUrl;
      }

      const fileMetadata = await this.getFileMetadata(fileId);
      const fileName = options.fileName || fileMetadata.name || `download_${fileId}`;
      const outputPath = options.outputPath || process.cwd();
      const filePath = path.join(outputPath, fileName);

      if (options.maxSize && fileMetadata.size && parseInt(fileMetadata.size) > options.maxSize) {
        throw new Error(`File size (${fileMetadata.size} bytes) exceeds maximum allowed size (${options.maxSize} bytes)`);
      }

      logger.info(`Downloading Google Drive file: ${fileName} (${fileMetadata.size} bytes)`);

      let downloadStream: Readable;

      if (this.isGoogleWorkspaceFile(fileMetadata.mimeType)) {
        downloadStream = await this.exportGoogleWorkspaceFile(fileId, fileMetadata.mimeType);
      } else {
        downloadStream = await this.downloadRegularFile(fileId);
      }

      await this.saveStreamToFile(downloadStream, filePath);

      const stats = fs.statSync(filePath);

      logger.info(`Successfully downloaded: ${fileName} (${stats.size} bytes)`);

      return {
        filePath,
        fileName,
        fileSize: stats.size,
        mimeType: fileMetadata.mimeType || 'application/octet-stream'
      };

    } catch (error) {
      logger.error('Error downloading Google Drive file:', error);
      throw error;
    }
  }

  async downloadAsBuffer(fileIdOrUrl: string): Promise<Buffer> {
    try {
      let fileId: string;

      if (fileIdOrUrl.includes('drive.google.com')) {
        const driveInfo = parseGoogleDriveUrl(fileIdOrUrl);
        if (!driveInfo) {
          throw new Error('Invalid Google Drive URL');
        }
        fileId = driveInfo.fileId;
      } else {
        fileId = fileIdOrUrl;
      }

      const fileMetadata = await this.getFileMetadata(fileId);

      let downloadStream: Readable;

      if (this.isGoogleWorkspaceFile(fileMetadata.mimeType)) {
        downloadStream = await this.exportGoogleWorkspaceFile(fileId, fileMetadata.mimeType);
      } else {
        downloadStream = await this.downloadRegularFile(fileId);
      }

      return this.streamToBuffer(downloadStream);

    } catch (error) {
      logger.error('Error downloading Google Drive file to buffer:', error);
      throw error;
    }
  }

  private async getFileMetadata(fileId: string) {
    try {
      const response = await this.drive.files.get({
        fileId,
        fields: 'id,name,size,mimeType,parents'
      });
      return response.data;
    } catch (error) {
      logger.error(`Error getting file metadata for ${fileId}:`, error);
      throw new Error(`Failed to get file metadata: ${error}`);
    }
  }

  private async downloadRegularFile(fileId: string): Promise<Readable> {
    try {
      const response = await this.drive.files.get({
        fileId,
        alt: 'media'
      }, {
        responseType: 'stream'
      });
      return response.data;
    } catch (error) {
      logger.error(`Error downloading regular file ${fileId}:`, error);
      throw new Error(`Failed to download file: ${error}`);
    }
  }

  private async exportGoogleWorkspaceFile(fileId: string, mimeType: string): Promise<Readable> {
    try {
      const exportMimeType = this.getExportMimeType(mimeType);
      const response = await this.drive.files.export({
        fileId,
        mimeType: exportMimeType
      }, {
        responseType: 'stream'
      });
      return response.data;
    } catch (error) {
      logger.error(`Error exporting Google Workspace file ${fileId}:`, error);
      throw new Error(`Failed to export file: ${error}`);
    }
  }

  private getExportMimeType(originalMimeType: string): string {
    const exportMap: Record<string, string> = {
      'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.google-apps.drawing': 'image/png'
    };

    return exportMap[originalMimeType] || 'application/pdf';
  }

  private isGoogleWorkspaceFile(mimeType: string): boolean {
    const workspaceMimeTypes = [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
      'application/vnd.google-apps.drawing'
    ];
    return workspaceMimeTypes.includes(mimeType);
  }

  private async saveStreamToFile(stream: Readable, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(filePath);

      stream.on('error', (error) => {
        writeStream.destroy();
        reject(error);
      });

      writeStream.on('error', (error) => {
        reject(error);
      });

      writeStream.on('finish', () => {
        resolve();
      });

      stream.pipe(writeStream);
    });
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      stream.on('data', (chunk) => {
        chunks.push(chunk);
      });

      stream.on('error', (error) => {
        reject(error);
      });

      stream.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });
  }

  async checkFileExists(fileIdOrUrl: string): Promise<boolean> {
    try {
      let fileId: string;

      if (fileIdOrUrl.includes('drive.google.com')) {
        const driveInfo = parseGoogleDriveUrl(fileIdOrUrl);
        if (!driveInfo) {
          return false;
        }
        fileId = driveInfo.fileId;
      } else {
        fileId = fileIdOrUrl;
      }

      await this.getFileMetadata(fileId);
      return true;
    } catch {
      return false;
    }
  }

  async getFileInfo(fileIdOrUrl: string) {
    let fileId: string;

    if (fileIdOrUrl.includes('drive.google.com')) {
      const driveInfo = parseGoogleDriveUrl(fileIdOrUrl);
      if (!driveInfo) {
        throw new Error('Invalid Google Drive URL');
      }
      fileId = driveInfo.fileId;
    } else {
      fileId = fileIdOrUrl;
    }

    return this.getFileMetadata(fileId);
  }
}