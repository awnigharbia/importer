export interface GoogleDriveInfo {
  fileId: string;
  fileName?: string;
  directUrl: string;
}

export function parseGoogleDriveUrl(url: string): GoogleDriveInfo | null {
  try {
    const patterns = [
      /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
      /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
      /drive\.google\.com\/uc\?id=([a-zA-Z0-9_-]+)/,
      /drive\.google\.com\/uc\?export=download&id=([a-zA-Z0-9_-]+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        const fileId = match[1];
        return {
          fileId,
          directUrl: `https://drive.google.com/uc?export=download&id=${fileId}`,
        };
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

export function isGoogleDriveUrl(url: string): boolean {
  return url.includes('drive.google.com') || url.includes('docs.google.com');
}