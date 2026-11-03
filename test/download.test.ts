import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { download } from '../src/download.js';
import { digest, temporary } from './support.js';

test('download retries and checksums using deterministic fetch responses', async t => {
  const root = await temporary(t);
  const bytes = Buffer.from('fixture');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    calls++;
    assert.equal(options.redirect, 'follow');
    return calls < 3 ? new Response('retry', { status: 503 }) : new Response(bytes);
  });
  const result = await download('https://fixture.invalid/source.zip', join(root, 'source.zip'), { checksum: digest(bytes) });
  assert.equal(calls, 3); assert.equal(result.sha256, digest(bytes));
  assert.deepEqual(await readFile(result.path), bytes);
  calls = 3;
  await assert.rejects(download('https://fixture.invalid/bad.zip', join(root, 'bad.zip'), { checksum: '0'.repeat(64) }), /SHA-256/);
  assert.equal(calls, 6);
  assert.deepEqual(await readFile(join(root, 'bad.zip')), bytes);
  await assert.rejects(readFile(join(root, 'bad.zip.partial')));
});

test('fetch request timeout and cancellation bound attempts without publishing partial files', async t => {
  const root = await temporary(t);
  let calls = 0;
  // Keep an active handle like a real socket, since AbortSignal.timeout is unref'ed.
  const keepalive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepalive));
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    });
  });
  await assert.rejects(download('https://fixture.invalid/hang', join(root, 'hang.zip'), { timeoutMs: 10 }));
  assert.equal(calls, 3);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  await assert.rejects(download('https://fixture.invalid/cancel', join(root, 'cancel.zip'), { signal: controller.signal }));
  clearTimeout(timer);
  assert.equal(calls, 4);
  await assert.rejects(readFile(join(root, 'cancel.zip')));
});

test('real HTTP retry cap, redirect, checksums, timeout and cancellation (when sockets are available)', async t => {
  const root = await temporary(t);
  const bytes = Buffer.from('source zip fixture');
  const counts = new Map<string, number>();
  const server = createServer((req, res) => {
    const url = req.url!;
    const count = (counts.get(url) ?? 0) + 1; counts.set(url, count);
    if (url === '/hang') return;
    if (url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
    if (url === '/fail' || (url === '/retry' && count < 3)) { res.writeHead(503); res.end('retry'); return; }
    res.end(bytes);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.skip('当前沙箱不允许监听本地端口；GitHub CI 执行真实 HTTP 测试'); return;
  }
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const ok = await download(`${base}/retry`, join(root, 'retry.zip'), { checksum: digest(bytes) });
  assert.equal(counts.get('/retry'), 3); assert.equal(ok.sha256, digest(bytes)); assert.equal(ok.bytes, bytes.length);
  assert.deepEqual(await readFile(ok.path), bytes);
  await download(`${base}/redirect`, join(root, 'redirect.zip'));
  await assert.rejects(download(`${base}/fail`, join(root, 'failed.zip')), /503/);
  assert.equal(counts.get('/fail'), 3);
  await assert.rejects(download(`${base}/bad`, join(root, 'bad.zip'), { checksum: '0'.repeat(64) }), /SHA-256/);
  assert.equal(counts.get('/bad'), 3);
  await assert.rejects(download(`${base}/hang`, join(root, 'hang.zip'), { timeoutMs: 20 }));
  assert.equal(counts.get('/hang'), 3);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  await assert.rejects(download(`${base}/hang`, join(root, 'cancel.zip'), { signal: controller.signal }));
  clearTimeout(timer);
  assert.equal(counts.get('/hang'), 4);
  await assert.rejects(readFile(join(root, 'cancel.zip.partial')));
});
