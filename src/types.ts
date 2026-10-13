export type JumpProfile = { name?: string; enabled: boolean; host: string; port: number; username: string; auth: string; keyPath: string; password?: string; passphrase?: string; rememberPassword?: boolean; hasPassword?: boolean };
export type Profile = { name: string; host: string; port: number; username: string; auth: string; keyPath: string; password?: string; passphrase?: string; rememberPassword?: boolean; hasPassword?: boolean; jump?: JumpProfile; jumpName?: string };
export type Bookmark = { line: number; note: string; color: string };
export type Doc = { id: string; name: string; origin?: string; remote: boolean; compressed: boolean; size: number; ready: boolean; lines: number; bookmarkKey: string; bookmarks: Bookmark[]; preview?: string[] };
export type Row = { line: number; position?: number; text: string; truncated?: boolean; displayTruncated?: boolean };
export type LogFilter = { token: string; count: number; total: number; capped: boolean; query: string };
export type Entry = { name: string; directory: boolean; size: number; mtime: number };
export type LocalListing = { path: string; root: string; entries: Entry[] };
export type Match = { line: number; text: string; file?: string; source?: string };
export type LogFont = { family: string; size: number };
export type SearchResult = { matches: Match[]; count: number; capped: boolean; truncatedLines: number; files?: number; searchedFiles?: number; errors?: string[]; source?: string; paths?: string[] };
export type ViewerEvent = { type: string; id?: string; requestId?: string; bytes?: number; size?: number; count?: number; kind?: string; state?: string; error?: string; destination?: string; file?: string; fileIndex?: number; files?: number; completedFiles?: number; failedFiles?: number; phase?: string; currentBytes?: number; currentSize?: number; source?: string; message?: string } & Partial<Doc>;
declare global {
  const __APP_VERSION__: string;
  interface Window {
    viewer: {
      settings(): Promise<{ profiles: Profile[]; theme?: string; logFont?: LogFont; version?: string; selectedProfile?: string; directories: { download: string; extract: string }; jumpProfiles: JumpProfile[]; selectedJump?: string; localPaths?: string[] }>;
      saveTheme(theme: string): Promise<string>;
      saveLogFont(font: LogFont): Promise<LogFont>;
      saveProfile(profile: Profile): Promise<Profile[]>;
      loadJumpProfile(name: string): Promise<JumpProfile>;
      saveJumpProfile(profile: JumpProfile): Promise<JumpProfile[]>;
      loadProfile(name: string): Promise<Profile>;
      connect(profile: Profile): Promise<{ name: string; home: string }>;
      disconnect(): Promise<void>;
      batchTransfer(directory: string, pattern: string, unpack: boolean): Promise<{ paths: string[]; openPath?: string; completedFiles: number; failedFiles: number; errors: string[] }>;
      chooseDirectory(kind: string): Promise<{ download: string; extract: string }>;
      openExtracted(file: string): Promise<Doc>;
      searchExtracted(paths: string[], query: string, options: { regex: boolean; caseSensitive: boolean }, requestId: string): Promise<SearchResult>;
      searchFiles(directory: string, pattern: string, query: string, options: { regex: boolean; caseSensitive: boolean }, requestId: string): Promise<SearchResult>;
      chooseKey(): Promise<string | undefined>;
      list(path: string): Promise<{ path: string; entries: Entry[] }>;
      chooseLocalFolder(): Promise<LocalListing | null>;
      listLocal(path: string): Promise<LocalListing>;
      openLocalFile(path: string): Promise<Doc>;
      searchLocalFiles(directory: string, pattern: string, query: string, options: { regex: boolean; caseSensitive: boolean }, requestId: string): Promise<SearchResult>;
      openRemote(path: string): Promise<Doc>;
      openLocal(): Promise<Doc | null>;
      page(id: string, start: number, count: number, filterToken?: string): Promise<Row[]>;
      filter(id: string, query: string, caseSensitive: boolean, requestId: string): Promise<LogFilter>;
      clearFilter(id: string): Promise<void>;
      search(id: string, query: string, options: { regex: boolean; caseSensitive: boolean }, requestId: string): Promise<SearchResult>;
      cancelSearch(): Promise<void>;
      follow(enabled: boolean): Promise<boolean>;
      saveBookmarks(key: string, bookmarks: Bookmark[]): Promise<void>;
      download(path: string): Promise<unknown>;
      extract(path?: string): Promise<{ destination: string; paths: string[]; openPath?: string } | null>;
      cancelTask(id: string): Promise<void>;
      onEvent(callback: (event: ViewerEvent) => void): () => void;
    };
  }
}
