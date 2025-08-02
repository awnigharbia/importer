declare module '@abrifq/google-drive-downloader' {
  interface GoogleDriveDownloader {
    downloadFile(fileId: string, outputPath: string, progressCallback?: (progress: number) => void): Promise<void>;
  }
  
  const GoogleDriveDownloader: GoogleDriveDownloader;
  export default GoogleDriveDownloader;
}