import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { message } from './io.js';
import { scan } from './scan.js';
import { validModuleName } from './index.js';
import { summary } from './report.js';
import type { Config } from './types.js';

export const help = `Mooncakes 工具链兼容性扫描器（Linux / Node.js >=22）

用法: npm start -- [参数]
  --days <天数>          发布窗口，默认 30（UTC，含两端）
  --jobs <数量>          同时检查模块数，默认 2
  --timeout <秒>         每次 moon check 限时，默认 300
  --work-dir <目录>      默认 .mooncakes-check
  --output-dir <目录>    默认 results
  --package <模块名>     在筛选结果内精确匹配，可重复
  --limit <数量>         最多检查模块数（按模块名字典序）
  --help                显示帮助

退出码: 0 完整扫描无回归；1 有回归候选；2 运行错误或扫描不完整。
`;

export function parseConfig(args: string[], cwd = process.cwd()): Config | undefined {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    days: { type: 'string', default: '30' }, jobs: { type: 'string', default: '2' },
    timeout: { type: 'string', default: '300' }, 'work-dir': { type: 'string', default: '.mooncakes-check' },
    'output-dir': { type: 'string', default: 'results' }, package: { type: 'string', multiple: true },
    limit: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return undefined;
  if (positionals.length) throw new Error('不支持位置参数');
  const integer = (name: string, raw: string, max: number) => {
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`--${name} 必须是 1 到 ${max} 的整数`);
    return value;
  };
  const packages = [...new Set(values.package ?? [])];
  for (const name of packages) if (!validModuleName(name)) throw new Error(`无效模块名: ${name}`);
  if (!values['work-dir'] || !values['output-dir']) throw new Error('目录不能为空');
  return { days: integer('days', values.days, 36500), jobs: integer('jobs', values.jobs, 256),
    timeout: integer('timeout', values.timeout, 2_147_483),
    workDir: resolve(cwd, values['work-dir']), outputDir: resolve(cwd, values['output-dir']), packages,
    limit: values.limit === undefined ? undefined : integer('limit', values.limit, Number.MAX_SAFE_INTEGER) };
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const config = parseConfig(args);
  if (!config) { console.log(help); return 0; }
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    if (!controller.signal.aborted) console.error(`收到 ${signal}，终止子进程并保存报告…`);
    controller.abort(new Error(`收到 ${signal}`));
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const report = await scan(config, { signal: controller.signal });
    console.log(JSON.stringify({ report: `${report.outputDir}/report.json`, status: report.status, ...summary(report), exitCode: report.exitCode }, null, 2));
    return report.exitCode;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }, error => { console.error(message(error)); process.exitCode = 2; });
}
