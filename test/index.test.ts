import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { selectRelease, packageUrl, selectPackages, cloneIndex } from '../src/index.js';
import { parseConfig } from '../src/cli.js';
import { config, fakeScan, now, temporary } from './support.js';

const row = (version: string, created_at: string, yanked = false) => JSON.stringify({ name: 'demo/package', version, created_at, yanked, checksum: 'a'.repeat(64) });
test('UTC inclusive window, first publication, future and timezone boundaries', () => {
  for (const date of ['2026-10-04T00:00:00Z', '2026-10-04T08:00:00+08:00', now.toISOString()]) {
    assert.ok(selectRelease(row('1.0.0', date), 'demo/package', now, 30));
  }
  for (const date of ['2026-10-03T23:59:59.999Z', '2026-11-03T00:00:00.001Z']) {
    assert.equal(selectRelease(row('1.0.0', date), 'demo/package', now, 30), undefined);
  }
});
test('fixed index selects highest SemVer even when that version predates the window', async () => {
  const fixture = await readFile(resolve('test/fixtures/index/user/demo/calendar.index'), 'utf8');
  const release = selectRelease(fixture, 'demo/calendar', now, 30)!;
  assert.equal(release.version, '1.10.0');
  assert.equal(release.recentReleaseAt, '2026-10-20T12:00:00+08:00');
});
test('prereleases, duplicate yank records and all-yanked modules', () => {
  const recent = now.toISOString();
  assert.equal(selectRelease([row('1.0.0-beta.9', recent), row('1.0.0-beta.10', recent)].join('\n'), 'demo/package', now, 30)?.version, '1.0.0-beta.10');
  assert.equal(selectRelease([row('1.0.0-rc.1', recent), row('1.0.0', recent)].join('\n'), 'demo/package', now, 30)?.version, '1.0.0');
  assert.equal(selectRelease([row('1.0.0', recent), row('1.0.0', recent, true)].join('\n'), 'demo/package', now, 30), undefined);
  assert.equal(selectRelease([row('2.0.0', recent, true), row('1.0.0', '2025-01-01T00:00:00Z')].join('\n'), 'demo/package', now, 30), undefined);
});
test('malformed metadata is reported instead of silently skipped', () => {
  assert.throws(() => selectRelease('{bad', 'demo/package', now, 30), /第 1 行/);
  assert.throws(() => selectRelease(row('no-version', now.toISOString()), 'demo/package', now, 30), /SemVer/);
  assert.throws(() => selectRelease(row('1.0.0', '2026-10-30T00:00:00'), 'demo/package', now, 30), /created_at/);
});
test('missing timestamps exclude the entire release, including latest-version selection', () => {
  const unknown = JSON.stringify({ name: 'demo/package', version: '9.0.0', checksum: 'b'.repeat(64) });
  assert.equal(selectRelease(unknown, 'demo/package', now, 30), undefined);
  assert.equal(selectRelease(`${unknown}\n${row('1.0.0', now.toISOString())}`, 'demo/package', now, 30)?.version, '1.0.0');
  for (const created_at of [null, '']) {
    assert.equal(selectRelease(JSON.stringify({ name: 'demo/package', version: '9.0.0', created_at }), 'demo/package', now, 30), undefined);
  }
});
test('registry download URL encodes nested name and build metadata', () => {
  assert.equal(packageUrl('owner/module/child', '1.0.0+build.1'), 'https://download.mooncakes.io/user/owner/module%2Fchild/1.0.0%2Bbuild.1.zip');
  assert.throws(() => packageUrl('../module', '1.0.0'));
  assert.equal(packageUrl('demo/中文', '1.0.0'), 'https://download.mooncakes.io/user/demo/%E4%B8%AD%E6%96%87/1.0.0.zip');
});
test('shallow snapshot, package filtering and limit are deterministic', async t => {
  const root = await temporary(t);
  await fakeScan(root, [{ name: 'demo/c' }, { name: 'demo/a' }, { name: 'demo/b' }]);
  const index = await cloneIndex(resolve(root, 'copy'), resolve(root, 'logs'), undefined, `file://${root}/registry`);
  assert.match(index.commit, /^[a-f0-9]{40}$/);
  const selected = await selectPackages(index.path, config(root, { packages: ['demo/c', 'demo/b'], limit: 1 }), now);
  assert.equal(selected.eligible, 3); assert.equal(selected.packages[0]?.name, 'demo/b');
  const missing = await selectPackages(index.path, config(root, { packages: ['demo/missing'] }), now);
  assert.equal(missing.errors.length, 1);
});
test('CLI defaults, repeats, invalid arguments and timeout overflow', () => {
  const args = parseConfig([])!;
  assert.deepEqual([args.days, args.jobs, args.timeout], [30, 2, 300]);
  assert.deepEqual(parseConfig(['--package', 'a/b', '--package=a/c'])?.packages, ['a/b', 'a/c']);
  assert.equal(parseConfig(['--help']), undefined);
  for (const arg of [['--jobs', '0'], ['--timeout', '2147484'], ['--days', '-1'], ['--limit', 'NaN'], ['--package', '../b'], ['--unknown']]) assert.throws(() => parseConfig(arg));
});
