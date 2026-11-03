import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseConfig } from '../src/cli.js';
import { prepareHome } from '../src/environment.js';
import { runProcess, requireSuccess, successful } from '../src/process.js';
import { scan } from '../src/scan.js';
import { atomicWrite } from '../src/io.js';
import { channels, type ProcessResult } from '../src/types.js';

// Explicit online acceptance command. Uses the same installer and scanner,
// then verifies warning suppression with both freshly downloaded toolchains.
async function main(): Promise<void> {
  const config = parseConfig(['--limit', '3', ...process.argv.slice(2)]);
  if (!config) throw new Error('smoke 参数请参考 npm start -- --help');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const report = await scan(config, { signal: controller.signal });
    process.exitCode = report.exitCode;
    if (!report.index || !report.toolchains.stable || !report.toolchains['pre-release'] || controller.signal.aborted) return;
    const checks: Partial<Record<typeof channels[number], { baseline: ProcessResult; ignored: ProcessResult }>> = {};
    let ok = true;
    for (const channel of channels) {
      const work = join(report.workDir, 'warning-smoke', channel);
      const source = join(work, 'source');
      await mkdir(work, { recursive: true });
      await cp(resolve('test/fixtures/warning'), source, { recursive: true });
      const home = join(work, 'moon-home');
      const env = await prepareHome(report.toolchains[channel]!, home, report.index);
      const logs = join(report.outputDir, 'logs', 'warning-smoke', channel);
      const remote = await runProcess({ command: 'git', args: ['-C', join(home, 'registry', 'index'), 'remote', 'set-url', 'origin', pathToFileURL(report.index.path).href],
        cwd: work, env, logPrefix: `${logs}-index`, timeoutMs: 30_000, signal: controller.signal });
      requireSuccess(remote);
      const run = (args: string[], suffix: string) => runProcess({ command: join(home, 'bin', 'moon'), args, cwd: source, env,
        logPrefix: `${logs}-${suffix}`, timeoutMs: config.timeout * 1000, signal: controller.signal });
      const baseline = await run(['check', '-j', '1'], 'baseline');
      const baselineText = await readFile(baseline.stderrLog, 'utf8') + await readFile(baseline.stdoutLog, 'utf8');
      await rm(join(source, '_build'), { force: true, recursive: true });
      await rm(join(source, 'target'), { force: true, recursive: true });
      const ignored = await run(['check', '--warn-list=-a', '-j', '1'], 'ignored');
      checks[channel] = { baseline, ignored };
      const ignoredText = await readFile(ignored.stderrLog, 'utf8') + await readFile(ignored.stdoutLog, 'utf8');
      ok &&= successful(baseline) && /warning/i.test(baselineText) && successful(ignored) && !/Warning(?:\s|\[|:)/i.test(ignoredText);
    }
    await atomicWrite(join(report.outputDir, 'warning-smoke.json'), JSON.stringify({ ok, checks }, null, 2));
    if (!ok) process.exitCode = 2;
    else await rm(join(report.workDir, 'warning-smoke'), { recursive: true, force: true });
    console.log(`warning 冒烟验证: ${ok ? '通过' : '失败'}；详情 ${report.outputDir}/warning-smoke.json`);
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
main().catch(error => { console.error(error); process.exitCode = 2; });
