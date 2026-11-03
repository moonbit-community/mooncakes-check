import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { installToolchain } from '../src/toolchain.js';
import { temporary, exec, digest } from './support.js';

test('installs two independent tar distributions, records hashes and versions, bundles matching core', async t => {
  const root = await temporary(t);
  const tarballs = new Map<string, Buffer>();
  for (const distribution of ['latest', 'pre-release']) {
    const payload = join(root, distribution);
    for (const dir of ['bin/internal', 'lib', 'include', 'core']) await mkdir(join(payload, dir), { recursive: true });
    await writeFile(join(payload, 'core', 'moon.mod.json'), '{"name":"moonbitlang/core"}');
    await writeFile(join(payload, 'bin', 'moon'), `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');
if(process.argv[2]==='version'){console.log('fixture-${distribution}');process.exit(0);}
if(process.argv[2]!=='bundle'||!process.argv.includes('--warn-list=-a'))process.exit(1);
if(!fs.existsSync('moon.mod.json'))process.exit(2);
fs.appendFileSync(path.join(process.env.MOON_HOME,'bundles.jsonl'),JSON.stringify({args:process.argv.slice(2),home:process.env.MOON_HOME})+'\\n');
`);
    await writeFile(join(payload, 'bin', 'internal', 'tcc'), '#!/bin/sh\nexit 0\n');
    await chmod(join(payload, 'bin', 'moon'), 0o600);
    const binary = join(root, `${distribution}.tar.gz`), core = join(root, `core-${distribution}.tar.gz`);
    await exec('tar', ['czf', binary, '-C', payload, 'bin', 'lib', 'include']);
    await exec('tar', ['czf', core, '-C', payload, 'core']);
    tarballs.set(`/binaries/${distribution}/moonbit-linux-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}.tar.gz`, await readFile(binary));
    tarballs.set(`/cores/core-${distribution}.tar.gz`, await readFile(core));
  }
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const bytes = tarballs.get(new URL(url).pathname);
    assert.ok(bytes, `Unexpected download: ${url}`);
    return new Response(new Uint8Array(bytes));
  });
  const homes: string[] = [];
  for (const channel of ['stable', 'pre-release'] as const) {
    const toolchain = await installToolchain(channel, join(root, 'work'), join(root, 'results'), undefined, 'https://fixture.invalid');
    homes.push(toolchain.root);
    assert.equal(toolchain.version, `fixture-${toolchain.distribution}`);
    assert.equal(toolchain.archives.length, 2);
    assert.equal(toolchain.setup.length, 5);
    for (const archive of toolchain.archives) assert.equal(archive.sha256, digest(await readFile(archive.path)));
    const bundles = (await readFile(join(toolchain.root, 'bundles.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
    assert.deepEqual(bundles.map(b => b.args), [['bundle', '--warn-list=-a', '--all'], ['bundle', '--warn-list=-a', '--target', 'wasm-gc', '--quiet']]);
    assert.ok(bundles.every(b => b.home === toolchain.root));
    assert.equal((await stat(join(toolchain.root, 'bin', 'internal', 'tcc'))).mode & 0o777, 0o755);
  }
  assert.notEqual(homes[0], homes[1]);
});
