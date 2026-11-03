import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractZip } from '../src/archive.js';
import { temporary, zip } from './support.js';

test('root and single wrapper layouts, both manifest formats, executable bits', async t => {
  const root = await temporary(t);
  for (const manifest of ['moon.mod', 'moon.mod.json']) for (const prefix of ['', 'wrapper/']) {
    const id = `${manifest}-${prefix ? 'wrapped' : 'root'}`;
    const archive = join(root, `${id}.zip`);
    await writeFile(archive, zip([{ name: `${prefix}${manifest}`, contents: '{}' }, { name: `${prefix}build.sh`, contents: '#!/bin/sh', mode: 0o100755 }]));
    const destination = join(root, id);
    const source = await extractZip(archive, destination);
    assert.equal(source, prefix ? join(destination, 'wrapper') : destination);
    assert.equal((await stat(join(source, 'build.sh'))).mode & 0o777, 0o755);
    assert.equal(await readFile(join(source, manifest), 'utf8'), '{}');
  }
});
test('rejects traversal, absolute names, backslashes, symlinks, duplicate files and ambiguous roots', async t => {
  const root = await temporary(t);
  const cases = [
    [{ name: '../escape' }], [{ name: '/escape' }], [{ name: 'C:/escape' }], [{ name: 'dir\\escape' }],
    [{ name: 'link', contents: '../outside', mode: 0o120777 }],
    [{ name: 'moon.mod' }, { name: 'moon.mod' }],
    [{ name: 'a/moon.mod' }, { name: 'b/moon.mod' }],
    [{ name: 'a/b/moon.mod' }], [{ name: 'moon.mod', mode: 0o020600 }],
  ];
  for (const [i, entries] of cases.entries()) {
    const archive = join(root, `${i}.zip`); await writeFile(archive, zip(entries));
    await assert.rejects(extractZip(archive, join(root, `${i}`)));
  }
  const archive = join(root, 'existing.zip'); await writeFile(archive, zip([{ name: 'moon.mod' }]));
  await mkdir(join(root, 'existing'));
  await assert.rejects(extractZip(archive, join(root, 'existing')), /EEXIST/);
});
test('truncated archive and cancellation fail cleanly', async t => {
  const root = await temporary(t);
  const archive = join(root, 'bad.zip'); await writeFile(archive, Buffer.from('broken'));
  await assert.rejects(extractZip(archive, join(root, 'bad')));
  await assert.rejects(extractZip(archive, join(root, 'cancelled'), AbortSignal.abort(new Error('cancelled'))), /cancelled/);
});
