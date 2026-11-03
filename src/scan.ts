import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractZip } from './archive.js';
import { download } from './download.js';
import { prepareHome } from './environment.js';
import { cloneIndex, packageUrl, selectPackages } from './index.js';
import { message } from './io.js';
import { requireSuccess, runProcess } from './process.js';
import { classify, ReportWriter } from './report.js';
import { installToolchain } from './toolchain.js';
import { channels, type Config, type Report, type PackageResult, type Toolchain, type IndexSnapshot } from './types.js';

export interface ScanServices {
  cloneIndex: typeof cloneIndex;
  installToolchain: typeof installToolchain;
  download: typeof download;
  now: () => Date;
  progress: (text: string) => void;
}

const defaults: ScanServices = { cloneIndex, installToolchain, download, now: () => new Date(), progress: console.log };

export function packageId(result: PackageResult): string {
  return `${result.package.name.replaceAll('/', '__')}-${result.package.version}-${createHash('sha256').update(result.package.name).digest('hex').slice(0, 8)}`;
}

export async function checkPackage(result: PackageResult, report: Report, services: ScanServices, signal: AbortSignal): Promise<void> {
  const id = packageId(result);
  const work = join(report.workDir, 'packages', id);
  const logs = join(report.outputDir, 'logs', 'packages', id);
  result.status = 'checking';
  try {
    signal.throwIfAborted();
    result.source = await services.download(packageUrl(result.package.name, result.package.version),
      join(report.outputDir, 'sources', `${id}.zip`), { checksum: result.package.checksum, signal });
    await mkdir(work, { recursive: true });
    // Each lane is attempted independently, even if the other failed to start.
    for (const channel of channels) {
      if (signal.aborted) break;
      let stage = `${channel}:extract`;
      try {
        const lane = join(work, channel);
        await mkdir(lane, { recursive: true });
        const source = await extractZip(result.source.path, join(lane, 'source'), signal);
        result.workDirs[channel] = source;
        for (const cache of ['.mooncakes', '_build', 'target']) await rm(join(source, cache), { force: true, recursive: true });
        stage = `${channel}:environment`;
        const toolchain = report.toolchains[channel] as Toolchain;
        const home = join(lane, 'moon-home');
        const index = report.index as IndexSnapshot;
        const env = await prepareHome(toolchain, home, index);
        const remote = await runProcess({ command: 'git', args: ['-C', join(home, 'registry', 'index'), 'remote', 'set-url', 'origin', pathToFileURL(index.path).href],
          cwd: lane, env, logPrefix: join(logs, `${channel}-index`), timeoutMs: 30_000, signal });
        requireSuccess(remote);
        stage = `${channel}:check`;
        result.checks[channel] = await runProcess({ command: join(home, 'bin', 'moon'), args: ['check', '--warn-list=-a', '-j', '1'],
          cwd: source, env, logPrefix: join(logs, channel), timeoutMs: report.config.timeout * 1000, signal });
      } catch (error) { result.errors.push({ stage, message: message(error) }); }
    }
  } catch (error) { result.errors.push({ stage: 'source', message: message(error) }); }
  result.status = signal.aborted ? 'interrupted' : classify(result);
  result.retained = result.status === 'regression';
  if (!result.retained) {
    try { await rm(work, { recursive: true, force: true }); }
    catch (error) {
      result.retained = true;
      result.errors.push({ stage: 'cleanup', message: message(error) });
      if (!signal.aborted) result.status = 'runtime-error';
    }
  }
}

export async function scan(config: Config, options: { signal?: AbortSignal; services?: Partial<ScanServices> } = {}): Promise<Report> {
  const services = { ...defaults, ...options.services };
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const now = services.now();
  const runId = `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const report: Report = {
    schemaVersion: 1, runId, startedAt: now.toISOString(), status: 'running', complete: false,
    config, workDir: join(config.workDir, runId), outputDir: join(config.outputDir, runId),
    toolchains: {}, results: [], errors: [], exitCode: 2,
    selection: { cutoff: new Date(now.getTime() - config.days * 86_400_000).toISOString(), eligible: 0, selected: 0 },
  };
  const writer = new ReportWriter();
  await mkdir(report.workDir, { recursive: true });
  await writer.save(report);
  services.progress(`运行 ${runId}；报告 ${join(report.outputDir, 'report.json')}`);
  try {
    signal.throwIfAborted();
    if (process.platform !== 'linux') throw new Error('本工具仅支持 Linux');
    report.index = await services.cloneIndex(join(report.workDir, 'index'), join(report.outputDir, 'logs'), signal);
    const selection = await selectPackages(report.index.path, config, now, signal);
    report.selection.eligible = selection.eligible;
    report.selection.selected = selection.packages.length;
    report.errors.push(...selection.errors);
    report.results = selection.packages.map(release => ({ package: release, status: 'pending', checks: {}, errors: [], workDirs: {}, retained: false }));
    await writer.save(report);
    services.progress(`符合时间范围 ${selection.eligible} 个模块；本轮检查 ${selection.packages.length} 个。`);
    for (const channel of channels) {
      services.progress(`安装 ${channel} 工具链及 core…`);
      report.toolchains[channel] = await services.installToolchain(channel, report.workDir, report.outputDir, signal);
      await writer.save(report);
    }
    let next = 0;
    const worker = async () => {
      while (!signal.aborted) {
        const result = report.results[next++];
        if (!result) return;
        await checkPackage(result, report, services, signal);
        await writer.save(report);
        services.progress(`${result.package.name}@${result.package.version}: ${result.status}`);
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: Math.min(config.jobs, report.results.length) }, () => worker().catch(error => {
      controller.abort(error); throw error;
    })));
    const failed = workers.find(r => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    report.complete = !signal.aborted && !report.errors.length && report.results.every(r => !['pending', 'checking', 'interrupted'].includes(r.status));
    report.status = signal.aborted ? 'interrupted' : report.complete ? 'completed' : 'failed';
  } catch (error) {
    report.errors.push({ stage: 'scan', message: message(error) });
    report.status = options.signal?.aborted ? 'interrupted' : 'failed';
  } finally {
    report.finishedAt = services.now().toISOString();
    await writer.save(report);
  }
  return report;
}
