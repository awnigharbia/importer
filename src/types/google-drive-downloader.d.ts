declare module '@abrifq/google-drive-downloader' {
  function getFileDownloadLinkFromFileLink(fileLink: string): Promise<string>;
  function getDownloadLinkFromID(fileID: string): Promise<string>;
  function fileIDExtractor(fileLink: string): string;
  
  export default getFileDownloadLinkFromFileLink;
  export { getDownloadLinkFromID, fileIDExtractor };
}