// Narrow declarations for the dependency APIs used here; no runtime shims.
declare module 'semver' {
  export function valid(version: string): string | null;
  export function rcompare(a: string, b: string): number;
}

declare module 'yauzl' {
  import { EventEmitter } from 'node:events';
  import { Readable } from 'node:stream';
  export interface Entry {
    fileName: string;
    externalFileAttributes: number;
    uncompressedSize: number;
    generalPurposeBitFlag: number;
  }
  export class ZipFile extends EventEmitter {
    readEntry(): void;
    close(): void;
    openReadStream(entry: Entry, callback: (error: Error | null, stream: Readable) => void): void;
  }
  export function open(path: string, options: {
    lazyEntries: boolean; autoClose: boolean; decodeStrings: boolean;
    validateEntrySizes: boolean; strictFileNames: boolean;
  }, callback: (error: Error | null, zip: ZipFile) => void): void;
}
