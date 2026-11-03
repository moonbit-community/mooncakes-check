import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { message, sha256 } from './io.js';
import type { Archive } from './types.js';

export async function retry<T>(operation: (attempt: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(attempt); }
    catch (error) {
      if (signal?.aborted || attempt === 3) throw error;
      await delay(250 * 2 ** (attempt - 1), undefined, { signal });
    }
  }
}

export async function download(url: string, path: string, options: {
  checksum?: string; signal?: AbortSignal; timeoutMs?: number;
} = {}): Promise<Archive> {
  await mkdir(dirname(path), { recursive: true });
  return retry(async () => {
    const temp = `${path}.partial`;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await fetch(url, { signal, redirect: 'follow' });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      await pipeline(Readable.from(response.body), createWriteStream(temp, { flags: 'w' }), { signal });
      const digest = await sha256(temp);
      if (options.checksum && digest !== options.checksum.toLowerCase()) {
        // Keep the received ZIP as evidence even on the final failed attempt.
        await rename(temp, path);
        throw new Error(`SHA-256 不匹配: expected=${options.checksum}, actual=${digest}`);
      }
      const bytes = (await stat(temp)).size;
      await rename(temp, path);
      return { url, path, sha256: digest, bytes };
    } catch (error) { throw new Error(`下载 ${url}: ${message(error)}`, { cause: error }); }
    finally { await rm(temp, { force: true }); }
  }, options.signal);
}
