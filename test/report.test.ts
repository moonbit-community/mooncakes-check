import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { packageId, scan } from '../src/scan.js';
import { ReportWriter, summary } from '../src/report.js';
import { ciSummary, summarize } from '../scripts/ci-summary.js';
import { config, exec, fakeScan, temporary } from './support.js';

async function publishSummary(root: string): Promise<string> {
  const path = join(root, 'summary.md');
  const old = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = path;
  try { await summarize(config(root).outputDir); }
  finally {
    if (old === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = old;
  }
  return readFile(path, 'utf8');
}

test('CI preserves whole-run statistics but uploads only regression evidence without toolchains', async t => {
  const root = await temporary(t);
  const report = await scan(config(root), { services: await fakeScan(root, [
    { name: 'demo/regression', prerelease: 'fail' }, { name: 'demo/crash', prerelease: 'crash' },
    { name: 'demo/pass' }, { name: 'demo/error', invalidChecksum: true },
  ]) });
  const regressions = report.results.filter(result => result.status === 'regression');
  assert.equal(regressions.length, 2);
  // A retained directory from a runtime/cleanup error must not be uploaded.
  const failed = report.results.find(result => result.status === 'runtime-error')!;
  failed.retained = true;
  const leftover = join(report.workDir, 'packages', packageId(failed));
  await mkdir(leftover, { recursive: true });
  await writeFile(join(leftover, 'leftover.txt'), 'not a regression');
  for (const file of [
    'toolchains/stable/toolchain.tar.gz', 'toolchains/stable/core.tar.gz',
    'toolchains/pre-release/toolchain.tar.gz', 'toolchains/pre-release/core.tar.gz',
    'logs/toolchains/install.log', 'logs/warning-smoke/check.log',
  ]) {
    const path = join(report.outputDir, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'must not be uploaded');
  }
  await writeFile(join(report.outputDir, 'warning-smoke.json'), JSON.stringify({ ok: true }));
  // Exclude a copied toolchain too, as well as the usual symlinked directories.
  const bin = join(report.workDir, 'packages', packageId(regressions[0]!), 'stable', 'moon-home', 'bin');
  await rm(bin);
  await mkdir(bin);
  await writeFile(join(bin, 'moon'), 'must not be archived');
  await new ReportWriter().save(report);

  const markdown = ciSummary(report);
  assert.match(markdown, /\| 本轮选中 \| 4 \|/);
  assert.match(markdown, /\| 回归候选 \| 2 \|/);
  assert.match(markdown, /\| 包运行错误 \| 1 \|/);
  assert.match(markdown, /demo\/regression@1.0.0/);
  assert.match(markdown, new RegExp(report.index!.commit));
  assert.equal(await publishSummary(root), markdown + '\nWarning 样例验证：**通过**。\n');

  const artifacts = join(report.outputDir, 'artifacts');
  assert.deepEqual((await readdir(artifacts)).sort(), ['logs', 'regressions.md', 'report.json', 'reproduction.tar.gz', 'sources']);
  const uploaded = JSON.parse(await readFile(join(artifacts, 'report.json'), 'utf8'));
  assert.deepEqual(uploaded.results, regressions);
  assert.deepEqual(uploaded.summary, summary(report));
  assert.deepEqual(uploaded.toolchains, report.toolchains);
  const original = JSON.parse(await readFile(join(report.outputDir, 'report.json'), 'utf8'));
  assert.equal(original.results.length, 4);
  assert.equal(await readFile(join(artifacts, 'regressions.md'), 'utf8'), await readFile(join(report.outputDir, 'regressions.md'), 'utf8'));
  const ids = regressions.map(packageId).sort();
  assert.deepEqual((await readdir(join(artifacts, 'logs', 'packages'))).sort(), ids);
  assert.deepEqual((await readdir(join(artifacts, 'sources'))).sort(), ids.map(id => `${id}.zip`));
  for (const result of regressions) {
    for (const path of [result.source!.path, ...Object.values(result.checks).flatMap(check => [check.stdoutLog, check.stderrLog])]) {
      assert.deepEqual(await readFile(join(artifacts, relative(report.outputDir, path))), await readFile(path));
    }
  }

  const entries = (await exec('tar', ['tzf', join(artifacts, 'reproduction.tar.gz')])).stdout.trim().split('\n');
  assert.ok(entries.includes('index/.git/HEAD'));
  for (const id of ids) for (const channel of ['stable', 'pre-release']) {
    assert.ok(entries.includes(`packages/${id}/${channel}/source/behavior.json`));
  }
  assert.ok(entries.every(path => path.startsWith('index/') || ids.some(id => path.startsWith(`packages/${id}/`))));
  assert.ok(entries.every(path => !/\/moon-home\/(bin|lib|include)(\/|$)/.test(path)));
});

test('runs without regressions keep CI summaries but produce no artifacts, including setup failures', async t => {
  const root = await temporary(t);
  const passed = await scan(config(root), { services: await fakeScan(root, [{ name: 'demo/pass' }]) });
  const failed = await scan(config(root), { services: {
    progress: () => {}, cloneIndex: async () => { throw new Error('network unavailable'); },
  } });
  const stale = join(passed.outputDir, 'artifacts');
  await mkdir(stale);
  await writeFile(join(stale, 'old-report.json'), 'stale upload');
  const markdown = await publishSummary(root);
  assert.ok(markdown.includes(ciSummary(passed)));
  assert.ok(markdown.includes(ciSummary(failed)));
  assert.match(markdown, /没有回归候选，本次运行不上传 Artifacts/);
  for (const report of [passed, failed]) {
    await assert.rejects(access(join(report.outputDir, 'artifacts')), { code: 'ENOENT' });
    await assert.rejects(access(join(report.outputDir, 'reproduction.tar.gz')), { code: 'ENOENT' });
    await access(join(report.outputDir, 'report.json'));
  }
});
