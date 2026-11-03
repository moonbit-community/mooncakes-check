import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { scan } from '../src/scan.js';
import { ciSummary, summarize } from '../scripts/ci-summary.js';
import { config, fakeScan, temporary } from './support.js';

test('CI statistics match report; snapshot and retained regression directories are archived', async t => {
  const root = await temporary(t);
  const report = await scan(config(root), { services: await fakeScan(root, [{ name: 'demo/regression', prerelease: 'fail' }]) });
  const markdown = ciSummary(report);
  assert.match(markdown, /\| 回归候选 \| 1 \|/);
  assert.match(markdown, /demo\/regression@1.0.0/);
  assert.match(markdown, new RegExp(report.index!.commit));
  const old = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = join(root, 'summary.md');
  try { await summarize(config(root).outputDir); }
  finally {
    if (old === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = old;
  }
  assert.equal(await readFile(join(root, 'summary.md'), 'utf8'), markdown);
  assert.ok((await readFile(join(report.outputDir, 'reproduction.tar.gz'))).length > 0);
});
