import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { summary } from '../src/report.js';
import { requireSuccess, runProcess } from '../src/process.js';
import type { Report } from '../src/types.js';

export function ciSummary(report: Report): string {
  const counts = summary(report);
  return [
    '## Mooncakes 兼容性扫描', '',
    `运行：\`${report.runId}\` · 状态：**${report.status}** · 退出码：**${report.exitCode}**`, '',
    '| 指标 | 数量 |', '| --- | ---: |',
    `| 时间范围内模块 | ${report.selection.eligible} |`,
    `| 本轮选中 | ${counts.selected} |`, `| 已完成 | ${counts.finished} |`,
    `| stable 通过 | ${counts.stablePassed} |`, `| pre-release 通过 | ${counts.prereleasePassed} |`,
    `| 回归候选 | ${counts.regressions} |`, `| 包运行错误 | ${counts.runtimeErrors} |`,
    `| 扫描错误 | ${counts.runErrors} |`, `| 未完成 | ${counts.unfinished} |`, '',
    `索引：\`${report.index?.commit ?? '未获取'}\``, '',
    ...(['stable', 'pre-release'] as const).flatMap(channel => [
      `### ${channel}`, '', '```text', report.toolchains[channel]?.version ?? '安装未完成', '```', '',
    ]),
    '### 回归候选', '',
    ...report.results.filter(r => r.status === 'regression').map(r => `- \`${r.package.name}@${r.package.version}\``),
    ...(counts.regressions ? [] : ['已完成的检查中没有回归候选。']), '',
    '从本次运行的 Artifacts 下载完整 report.json、regressions.md、检查日志、源码 ZIP 和工具链归档。', '',
  ].join('\n');
}

export async function summarize(outputDir: string): Promise<void> {
  let entries: Dirent[];
  try { entries = await readdir(outputDir, { withFileTypes: true }); }
  catch { entries = []; }
  const reports: Report[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { reports.push(JSON.parse(await readFile(join(outputDir, entry.name, 'report.json'), 'utf8')) as Report); }
    catch { /* A run can fail before producing its first report. */ }
  }
  let output = '';
  for (const report of reports) {
    output += ciSummary(report);
    try {
      const warning = JSON.parse(await readFile(join(report.outputDir, 'warning-smoke.json'), 'utf8')) as { ok: boolean };
      output += `\nWarning 样例验证：**${warning.ok ? '通过' : '失败'}**。详情见 warning-smoke.json。\n`;
    } catch { /* Full scans do not run the extra warning fixture. */ }
  }
  if (!reports.length) output = '## Mooncakes 兼容性扫描\n\n没有生成报告，请查看扫描步骤日志。\n';
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, output);
  else console.log(output);
  for (const report of reports) {
    const preserve: string[] = [];
    if (report.index) preserve.push('index');
    if (report.results.some(r => r.retained)) preserve.push('packages');
    if (!preserve.length) continue;
    await mkdir(report.outputDir, { recursive: true });
    const packed = await runProcess({ command: 'tar', args: ['czf', join(report.outputDir, 'reproduction.tar.gz'), '-C', report.workDir, ...preserve],
      cwd: report.workDir, logPrefix: join(report.outputDir, 'logs', 'ci-preserve'), timeoutMs: 120_000 });
    requireSuccess(packed);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  summarize(resolve(process.argv[2] ?? 'results')).catch(error => { console.error(error); process.exitCode = 2; });
}
