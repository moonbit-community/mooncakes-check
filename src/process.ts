import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { message } from './io.js';
import type { ProcessResult } from './types.js';

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logPrefix: string;
  timeoutMs: number;
  signal?: AbortSignal;
  killGraceMs?: number;
}

// Every child has its own Linux process group. File descriptors keep output
// bounded in memory and prevent grandchildren holding pipes from hanging us.
export async function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  const start = performance.now();
  const result: ProcessResult = {
    command: [options.command, ...options.args], cwd: options.cwd,
    kind: 'exited', exitCode: null, signal: null, startedAt: new Date().toISOString(),
    durationMs: 0, stdoutLog: `${options.logPrefix}.stdout.log`,
    stderrLog: `${options.logPrefix}.stderr.log`,
  };
  let out, err;
  try {
    await mkdir(dirname(options.logPrefix), { recursive: true });
    out = await open(result.stdoutLog, 'w');
    err = await open(result.stderrLog, 'w');
    if (options.signal?.aborted) { result.kind = 'cancelled'; return result; }
    await new Promise<void>((resolve) => {
      let child: ReturnType<typeof spawn>;
      let timer: NodeJS.Timeout | undefined;
      let escalation: NodeJS.Timeout | undefined;
      let closed = false;
      let stopping = false;
      const killGroup = (signal: NodeJS.Signals) => {
        if (child.pid) {
          try { process.kill(-child.pid, signal); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
              result.error = message(error); result.kind = 'io-error';
            }
          }
        }
      };
      const finish = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        // Also reap background descendants left by an otherwise normal exit.
        killGroup('SIGKILL');
        resolve();
      };
      const stop = (kind: 'timeout' | 'cancelled') => {
        if (stopping || closed) return;
        stopping = true;
        result.kind = kind;
        killGroup('SIGTERM');
        escalation = setTimeout(() => {
          escalation = undefined;
          killGroup('SIGKILL');
          if (closed) finish();
        }, options.killGraceMs ?? 1000);
      };
      const cancel = () => stop('cancelled');
      try {
        child = spawn(options.command, options.args, {
          cwd: options.cwd, env: options.env, detached: true,
          stdio: ['ignore', out!.fd, err!.fd],
        });
      } catch (error) {
        result.kind = 'spawn-error'; result.error = message(error); resolve(); return;
      }
      child.once('error', (error) => {
        result.kind = 'spawn-error'; result.error = message(error);
      });
      child.once('close', (code, signal) => {
        result.exitCode = code; result.signal = signal; closed = true;
        if (!escalation) finish();
      });
      timer = setTimeout(() => stop('timeout'), options.timeoutMs);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
    });
  } catch (error) {
    result.kind = 'io-error'; result.error = message(error);
  } finally {
    await out?.close();
    await err?.close();
    result.durationMs = Math.round(performance.now() - start);
  }
  return result;
}

export function successful(result: ProcessResult): boolean {
  return result.kind === 'exited' && result.exitCode === 0 && result.signal === null;
}

export function requireSuccess(result: ProcessResult): void {
  if (!successful(result)) throw new Error(
    `${result.command[0]}: ${result.kind}, exit=${result.exitCode}, signal=${result.signal}` +
    `${result.error ? ` (${result.error})` : ''}; 日志: ${result.stderrLog}`,
  );
}
