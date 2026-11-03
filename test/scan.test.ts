import assert from 'node:assert/strict';
import { access, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { scan } from '../src/scan.js';
import { summary } from '../src/report.js';
import { isolatedEnvironment } from '../src/environment.js';
import { toolchainUrls } from '../src/toolchain.js';
import { config, fakeScan, now, temporary, type PackageFixture } from './support.js';

test('all check combinations, warnings and natural crashes; regression retention and report agree', async t => {
  const root = await temporary(t);
  const fixtures: PackageFixture[] = [
    { name: 'demo/pass-pass' }, { name: 'demo/pass-fail', prerelease: 'fail' },
    { name: 'demo/fail-pass', stable: 'fail' }, { name: 'demo/fail-fail', stable: 'fail', prerelease: 'fail' },
    { name: 'demo/warning', stable: 'warning', prerelease: 'warning' },
    { name: 'demo/crash', prerelease: 'crash' }, { name: 'demo/stable-crash', stable: 'crash' },
  ];
  const report = await scan(config(root), { services: await fakeScan(root, fixtures) });
  assert.equal(report.status, 'completed'); assert.equal(report.complete, true); assert.equal(report.exitCode, 1);
  assert.equal(summary(report).regressions, 2); assert.equal(summary(report).finished, 7);
  for (const result of report.results) {
    assert.ok(result.checks.stable); assert.ok(result.checks['pre-release']);
    assert.equal(result.checks.stable.command.slice(1).join(' '), 'check --warn-list=-a -j 1');
    assert.equal(result.checks['pre-release'].command.includes('--target'), false);
    assert.equal(result.retained, result.status === 'regression');
    for (const path of Object.values(result.workDirs)) {
      if (result.retained) await access(path); else await assert.rejects(access(path));
    }
    await access(result.source!.path);
    await access(result.checks.stable.stdoutLog);
  }
  const written = JSON.parse(await readFile(join(report.outputDir, 'report.json'), 'utf8'));
  assert.equal(written.exitCode, report.exitCode); assert.deepEqual(written.summary, summary(report));
  const markdown = await readFile(join(report.outputDir, 'regressions.md'), 'utf8');
  assert.match(markdown, /demo\/pass-fail/); assert.match(markdown, /demo\/crash/);
  assert.doesNotMatch(markdown, /demo\/fail-fail/);
  assert.equal((await readdir(report.outputDir)).some(name => name.endsWith('.tmp')), false);
});

test('per-package homes, caches, workspaces and local index origin are isolated', async t => {
  const root = await temporary(t);
  const report = await scan(config(root), { services: await fakeScan(root, [{ name: 'demo/a' }, { name: 'demo/b' }]) });
  assert.equal(report.exitCode, 0);
  const homes = new Set<string>();
  const workspaces = new Set<string>();
  for (const result of report.results) for (const check of Object.values(result.checks)) {
    const output = JSON.parse((await readFile(check.stdoutLog, 'utf8')).trim());
    homes.add(output.env.MOON_HOME); workspaces.add(output.cwd);
    assert.ok(output.env.PATH.startsWith(`${output.env.MOON_HOME}/bin:`));
    assert.equal(output.env.MOON_CORE_OVERRIDE, undefined);
    assert.equal(output.config.index, `file://${report.index!.path}`);
  }
  assert.equal(homes.size, 4); assert.equal(workspaces.size, 4);
});

test('environment removes compiler/cache overrides; Linux architecture URLs', () => {
  const result = isolatedEnvironment('/tmp/lane', { PATH: '/old/bin:.:relative:/usr/bin', MOON_HOME: '/old', MOONC_OVERRIDE: '/bad',
    MOON_CORE_OVERRIDE: '/bad/core', MOON_DEP_CACHE: '/shared', MOON_BUILD_CACHE: '/shared', MOON_REGISTRY_API: '1', MOONCAKES_REGISTRY: 'bad',
    RUSTC_WRAPPER: 'bad', CC: 'bad', CFLAGS: 'bad', LD_PRELOAD: 'bad', TAR_OPTIONS: 'bad', HTTPS_PROXY: 'http://proxy' });
  for (const key of ['MOONC_OVERRIDE', 'MOON_CORE_OVERRIDE', 'MOON_DEP_CACHE', 'MOON_BUILD_CACHE', 'MOON_REGISTRY_API', 'MOONCAKES_REGISTRY', 'CC', 'CFLAGS', 'LD_PRELOAD', 'TAR_OPTIONS', 'RUSTC_WRAPPER']) assert.equal(result[key], undefined);
  assert.equal(result.HTTPS_PROXY, 'http://proxy');
  assert.equal(result.PATH, '/tmp/lane/bin:/old/bin:/usr/bin');
  assert.match(toolchainUrls('stable', 'x64').binary, /latest\/moonbit-linux-x86_64.tar.gz$/);
  assert.match(toolchainUrls('pre-release', 'arm64').core, /core-pre-release.tar.gz$/);
  assert.throws(() => toolchainUrls('stable', 'ia32'));
});

test('bad source checksum and unsafe archive do not prevent subsequent packages', async t => {
  const root = await temporary(t);
  const report = await scan(config(root, { jobs: 1 }), { services: await fakeScan(root, [
    { name: 'demo/a-bad', invalidChecksum: true }, { name: 'demo/b-unsafe', invalidZip: true }, { name: 'demo/z-good' },
  ]) });
  assert.equal(report.exitCode, 2); assert.equal(report.complete, true);
  assert.deepEqual(report.results.map(r => r.status), ['runtime-error', 'runtime-error', 'ok']);
  assert.equal(summary(report).regressions, 0);
});

test('scanner timeout is a runtime error; prerelease still runs after stable timeout', async t => {
  const root = await temporary(t);
  const report = await scan(config(root, { timeout: 0.15 }), { services: await fakeScan(root, [
    { name: 'demo/pre-timeout', prerelease: 'hang' }, { name: 'demo/stable-timeout', stable: 'hang' },
  ]) });
  assert.equal(report.exitCode, 2); assert.equal(summary(report).regressions, 0);
  assert.ok(report.results.every(r => r.status === 'runtime-error'));
  const stableTimeout = report.results.find(r => r.package.name === 'demo/stable-timeout')!;
  assert.equal(stableTimeout.checks.stable?.kind, 'timeout');
  assert.equal(stableTimeout.checks['pre-release']?.exitCode, 0);
});

test('process startup failure is distinct from a compiler failure and the other lane is attempted', async t => {
  const root = await temporary(t);
  const services = await fakeScan(root, [{ name: 'demo/start' }]);
  const install = services.installToolchain!;
  services.installToolchain = async (...args) => {
    const toolchain = await install(...args);
    if (args[0] === 'stable') await rm(join(toolchain.root, 'bin', 'moon'));
    return toolchain;
  };
  const report = await scan(config(root), { services });
  assert.equal(report.exitCode, 2);
  assert.equal(report.results[0]?.checks.stable?.kind, 'spawn-error');
  assert.equal(report.results[0]?.checks['pre-release']?.exitCode, 0);
});

test('mid-scan cancellation preserves completed results and leaves pending work explicit', async t => {
  const root = await temporary(t);
  const controller = new AbortController();
  const services = await fakeScan(root, [{ name: 'demo/a-done' }, { name: 'demo/b-pending' }]);
  services.progress = text => { if (text.startsWith('demo/a-done@')) controller.abort(new Error('test cancel')); };
  const report = await scan(config(root, { jobs: 1 }), { services, signal: controller.signal });
  assert.equal(report.exitCode, 2); assert.equal(report.complete, false); assert.equal(report.status, 'interrupted');
  assert.deepEqual(report.results.map(r => r.status), ['ok', 'pending']);
  assert.equal(JSON.parse(await readFile(join(report.outputDir, 'report.json'), 'utf8')).status, 'interrupted');
});

test('setup failures and cancellation before setup leave a readable incomplete report', async t => {
  const root = await temporary(t);
  const failed = await scan(config(root), { services: { now: () => now, progress: () => {}, cloneIndex: async () => { throw new Error('network unavailable'); } } });
  assert.equal(failed.exitCode, 2); assert.equal(failed.status, 'failed'); assert.equal(failed.complete, false);
  assert.match(failed.errors[0]!.message, /network unavailable/);
  const cancelled = await scan(config(root), { signal: AbortSignal.abort(), services: { progress: () => {} } });
  assert.equal(cancelled.exitCode, 2); assert.equal(cancelled.status, 'interrupted');
  await access(join(cancelled.outputDir, 'report.json'));
});
