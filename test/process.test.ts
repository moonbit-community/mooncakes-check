import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from '../src/process.js';
import { temporary } from './support.js';

test('captures streams, exit codes, duration, natural crashes and spawn errors', async t => {
  const root = await temporary(t);
  const run = (script: string, id: string) => runProcess({ command: process.execPath, args: ['-e', script], cwd: root, timeoutMs: 5000, logPrefix: join(root, id) });
  const ok = await run("console.log('hello');console.error('warning')", 'ok');
  assert.equal(ok.kind, 'exited'); assert.equal(ok.exitCode, 0); assert.equal(ok.signal, null);
  assert.match(await readFile(ok.stdoutLog, 'utf8'), /hello/); assert.match(await readFile(ok.stderrLog, 'utf8'), /warning/);
  assert.ok(ok.durationMs >= 0);
  assert.equal((await run('process.exit(7)', 'fail')).exitCode, 7);
  const crash = await run("process.kill(process.pid,'SIGKILL')", 'crash');
  assert.equal(crash.kind, 'exited'); assert.equal(crash.signal, 'SIGKILL'); assert.equal(crash.exitCode, null);
  const missing = await runProcess({ command: join(root, 'missing'), args: [], cwd: root, logPrefix: join(root, 'missing'), timeoutMs: 1000 });
  assert.equal(missing.kind, 'spawn-error'); assert.match(missing.error!, /ENOENT/);
});

async function running(pid: number): Promise<boolean> {
  try { return !(await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1]!.startsWith('Z'); }
  catch { return false; }
}

test('timeout kills the whole group, including a TERM-ignoring descendant after leader exits', async t => {
  const root = await temporary(t);
  const pidFile = join(root, 'child.pid');
  const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const parentCode = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const result = await runProcess({ command: process.execPath, args: ['-e', parentCode], cwd: root, logPrefix: join(root, 'timeout'), timeoutMs: 600, killGraceMs: 100 });
  assert.equal(result.kind, 'timeout');
  const pid = Number(await readFile(pidFile, 'utf8'));
  for (let i = 0; i < 10 && await running(pid); i++) await delay(20);
  assert.equal(await running(pid), false);
});

test('cancellation, including an already-aborted signal, does not look like a crash', async t => {
  const root = await temporary(t);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const result = await runProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: root,
    logPrefix: join(root, 'cancel'), timeoutMs: 5000, signal: controller.signal, killGraceMs: 30 });
  clearTimeout(timer);
  assert.equal(result.kind, 'cancelled');
  const early = await runProcess({ command: 'nonexistent', args: [], cwd: root, logPrefix: join(root, 'early'), timeoutMs: 5000, signal: AbortSignal.abort() });
  assert.equal(early.kind, 'cancelled'); assert.equal(early.exitCode, null);
});
