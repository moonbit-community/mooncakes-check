import { join, relative } from 'node:path';
import { atomicWrite } from './io.js';
import { successful } from './process.js';
import type { PackageResult, Report } from './types.js';

export function classify(result: PackageResult): PackageResult['status'] {
  const { stable, 'pre-release': prerelease } = result.checks;
  if (stable?.kind === 'cancelled' || prerelease?.kind === 'cancelled') return 'interrupted';
  if (result.errors.length || !stable || !prerelease || stable.kind !== 'exited' || prerelease.kind !== 'exited') return 'runtime-error';
  return successful(stable) && !successful(prerelease) ? 'regression' : 'ok';
}

export function reportExitCode(report: Report): 0 | 1 | 2 {
  if (!report.complete || report.errors.length || report.results.some(r => ['runtime-error', 'pending', 'checking', 'interrupted'].includes(r.status))) return 2;
  return report.results.some(r => r.status === 'regression') ? 1 : 0;
}

export function summary(report: Report): Record<string, number> {
  return {
    selected: report.results.length,
    finished: report.results.filter(r => ['ok', 'regression', 'runtime-error'].includes(r.status)).length,
    stablePassed: report.results.filter(r => r.checks.stable && successful(r.checks.stable)).length,
    prereleasePassed: report.results.filter(r => r.checks['pre-release'] && successful(r.checks['pre-release'])).length,
    regressions: report.results.filter(r => r.status === 'regression').length,
    runtimeErrors: report.results.filter(r => r.status === 'runtime-error').length,
    runErrors: report.errors.length,
    unfinished: report.results.filter(r => ['pending', 'checking', 'interrupted'].includes(r.status)).length,
  };
}

function link(path: string, report: Report): string {
  return relative(report.outputDir, path).split('/').map(encodeURIComponent).join('/');
}

export function renderRegressions(report: Report): string {
  const counts = summary(report);
  const lines = ['# Mooncakes 工具链兼容性扫描', '', `运行：\`${report.runId}\``, '',
    `状态：${report.status}；扫描完成：${report.complete ? '是' : '否'}；退出码：${report.exitCode}`, '',
    `筛选 ${counts.selected}，完成 ${counts.finished}，stable 通过 ${counts.stablePassed}，pre-release 通过 ${counts.prereleasePassed}，回归候选 ${counts.regressions}，包运行错误 ${counts.runtimeErrors}，扫描错误 ${counts.runErrors}，未完成 ${counts.unfinished}。`, '',
    `索引提交：\`${report.index?.commit ?? '尚未获取'}\``, '',
    '| 模块 | 版本 | stable 日志 | pre-release 日志 |', '| --- | --- | --- | --- |'];
  for (const result of report.results.filter(r => r.status === 'regression')) {
    const log = (channel: 'stable' | 'pre-release') => {
      const check = result.checks[channel]!;
      return `[stdout](${link(check.stdoutLog, report)}) / [stderr](${link(check.stderrLog, report)})`;
    };
    lines.push(`| ${result.package.name} | ${result.package.version} | ${log('stable')} | ${log('pre-release')} |`);
  }
  if (!counts.regressions) lines.push('', '本轮已完成的检查尚未发现回归候选。');
  lines.push('', '详细退出码、信号、耗时、运行错误、源码目录和工具链信息见 [report.json](report.json)。', '');
  return lines.join('\n');
}

export class ReportWriter {
  private pending: Promise<void> = Promise.resolve();
  save(report: Report): Promise<void> {
    report.exitCode = reportExitCode(report);
    const json = JSON.stringify({ ...report, summary: summary(report) }, null, 2) + '\n';
    const markdown = renderRegressions(report);
    this.pending = this.pending.then(async () => {
      await atomicWrite(join(report.outputDir, 'regressions.md'), markdown);
      await atomicWrite(join(report.outputDir, 'report.json'), json);
    });
    return this.pending;
  }
}
