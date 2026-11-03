import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { open, type Entry, type ZipFile } from 'yauzl';

export function safeArchivePath(name: string): string {
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error(`不安全的 ZIP 路径: ${JSON.stringify(name)}`);
  }
  const segments = name.replace(/\/$/, '').split('/');
  if (segments.some(part => !part || part === '.' || part === '..')) throw new Error(`ZIP 路径越界或歧义: ${name}`);
  return segments.join('/');
}

export async function extractZip(archive: string, destination: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  // A new destination prevents pre-existing links from redirecting extraction.
  await mkdir(destination, { recursive: false });
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    open(archive, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: true },
      (error, value) => error ? reject(error) : resolve(value));
  });
  const seen = new Set<string>();
  let totalBytes = 0;
  let count = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      let ended = false;
      let active = Promise.resolve();
      const abort = () => fail(signal?.reason ?? new Error('已取消'));
      const fail = (error: unknown) => {
        if (ended) return;
        ended = true;
        zip.close();
        signal?.removeEventListener('abort', abort);
        // Let any active write stop before callers clean up the destination.
        void active.then(() => reject(error), () => reject(error));
      };
      zip.on('error', fail);
      signal?.addEventListener('abort', abort, { once: true });
      zip.on('end', () => {
        if (ended) return;
        ended = true; signal?.removeEventListener('abort', abort); resolve();
      });
      zip.on('entry', (entry: Entry) => {
        active = (async () => {
          signal?.throwIfAborted();
          const name = safeArchivePath(entry.fileName);
          const mode = entry.externalFileAttributes >>> 16;
          const type = mode & 0o170000;
          if (type === 0o120000) throw new Error(`拒绝 ZIP 符号链接: ${name}`);
          if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw new Error(`拒绝 ZIP 特殊文件: ${name}`);
          if (entry.generalPurposeBitFlag & 1) throw new Error(`拒绝加密 ZIP: ${name}`);
          if (seen.has(name)) throw new Error(`重复 ZIP 路径: ${name}`);
          seen.add(name);
          totalBytes += entry.uncompressedSize;
          if (++count > 100_000 || totalBytes > 2 * 1024 ** 3) throw new Error('ZIP 超过解压上限（100000 条目 / 2 GiB）');
          const path = join(destination, name);
          const directory = entry.fileName.endsWith('/');
          if ((type === 0o040000 && !directory) || (type === 0o100000 && directory)) throw new Error(`ZIP 文件类型不一致: ${name}`);
          if (directory) await mkdir(path, { recursive: true });
          else {
            await mkdir(dirname(path), { recursive: true });
            const input = await new Promise<import('node:stream').Readable>((res, rej) => {
              zip.openReadStream(entry, (error, stream) => error ? rej(error) : res(stream));
            });
            await pipeline(input, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal });
            // Preserve executable bits, but strip special and group/world-write bits.
            await chmod(path, 0o644 | (mode & 0o111));
          }
        })();
        void active.then(() => { if (!ended) zip.readEntry(); }, fail);
      });
      if (signal?.aborted) abort(); else zip.readEntry();
    });
  } finally { zip.close(); }
  return findModuleRoot(destination);
}

export async function findModuleRoot(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(file => file.isFile() && ['moon.mod', 'moon.mod.json'].includes(file.name))) return directory;
  if (entries.length === 1 && entries[0]!.isDirectory()) {
    const wrapped = join(directory, entries[0]!.name);
    const files = await readdir(wrapped, { withFileTypes: true });
    if (files.some(file => file.isFile() && ['moon.mod', 'moon.mod.json'].includes(file.name))) return wrapped;
  }
  throw new Error('ZIP 根目录或唯一顶层目录中没有 moon.mod / moon.mod.json');
}
