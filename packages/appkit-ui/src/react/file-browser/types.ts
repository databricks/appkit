/** A single entry (file or directory) in a directory listing */
export interface DirectoryEntry {
  name?: string;
  path?: string;
  is_directory?: boolean;
  file_size?: number;
  last_modified?: string;
}

/** Metadata and content preview for a selected file */
export interface FilePreview {
  contentLength: number | undefined;
  contentType: string | undefined;
  lastModified: string | undefined;
  textPreview: string | null;
  isText: boolean;
  isImage: boolean;
}

/** Customizable labels for file browser components (i18n-ready) */
export interface FileBrowserLabels {
  /** Back button text (default: "Back to parent") */
  backToParent?: string;
  /** Empty directory message (default: "This directory is empty.") */
  emptyDirectory?: string;
  /** No volume configured message */
  noVolumeConfigured?: string;
  /** Retry button text (default: "Retry") */
  retry?: string;
  /** Select file prompt (default: "Select a file to preview") */
  selectFilePrompt?: string;
  /** Preview not available message */
  previewNotAvailable?: string;
  /** Failed to load preview message */
  previewFailed?: string;
  /** Download button text (default: "Download") */
  download?: string;
  /** Create button text (default: "Create") */
  create?: string;
  /** Folder name placeholder (default: "Folder name") */
  folderNamePlaceholder?: string;
  /** Size label (default: "Size") */
  size?: string;
  /** Type label (default: "Type") */
  type?: string;
  /** Modified label (default: "Modified") */
  modified?: string;
  /** Unknown value fallback (default: "Unknown") */
  unknown?: string;
}
