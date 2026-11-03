import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { Config, Toolchain, Channel, IndexSnapshot } from '../src/types.js';
import type { ScanServices } from '../src/scan.js';

export const exec = promisify(execFile);
export const now = new Date('2026-11-03T00:00:00.000Z');
export const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export async function temporary(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'mooncakes-check-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

export interface ZipEntry { name: string; contents?: string | Buffer; mode?: number }
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Deterministic stored ZIP fixtures, also able to express malformed paths and
// Unix symlinks which convenience ZIP writers refuse to create.
export function zip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = typeof entry.contents === 'string' ? Buffer.from(entry.contents) : entry.contents ?? Buffer.alloc(0);
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? (entry.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  const index = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

export function config(root: string, extra: Partial<Config> = {}): Config {
  return { days: 30, jobs: 2, timeout: 5, workDir: join(root, 'work'), outputDir: join(root, 'results'), packages: [], ...extra };
}

export interface PackageFixture { name: string; stable?: string; prerelease?: string; invalidChecksum?: boolean; invalidZip?: boolean }

export async function fakeScan(root: string, fixtures: PackageFixture[]): Promise<Partial<ScanServices>> {
  const repository = join(root, 'registry');
  await mkdir(repository, { recursive: true });
  const archives = new Map<string, Buffer>();
  for (const fixture of fixtures) {
    const archive = zip(fixture.invalidZip ? [{ name: '../escape', contents: 'bad' }] : [
      { name: 'moon.mod.json', contents: JSON.stringify({ name: fixture.name, version: '1.0.0' }) },
      { name: 'behavior.json', contents: JSON.stringify(fixture) },
      { name: '_build/old', contents: 'must disappear' }, { name: '.mooncakes/old', contents: 'must disappear' },
    ]);
    archives.set(fixture.name, archive);
    const path = join(repository, 'user', `${fixture.name}.index`);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify({ name: fixture.name, version: '1.0.0', created_at: now.toISOString(),
      checksum: fixture.invalidChecksum ? '0'.repeat(64) : digest(archive), yanked: false }) + '\n');
  }
  await mkdir(join(repository, 'user'), { recursive: true });
  // Keep an empty user tree in empty-index tests as well.
  await writeFile(join(repository, 'user', '.keep'), '');
  await exec('git', ['init', '-q', '-b', 'main', repository]);
  await exec('git', ['-C', repository, 'remote', 'add', 'origin', `file://${repository}`]);
  await exec('git', ['-C', repository, 'add', '.']);
  await exec('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixed index']);
  const commit = (await exec('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim();
  return {
    now: () => now, progress: () => {},
    cloneIndex: async (path): Promise<IndexSnapshot> => { await cp(repository, path, { recursive: true }); return { url: 'fixture', path, commit }; },
    installToolchain: async (channel, work): Promise<Toolchain> => fakeToolchain(join(work, 'toolchains', channel), channel),
    download: async (url, path, options) => {
      options?.signal?.throwIfAborted();
      const parsed = new URL(url).pathname.slice('/user/'.length).split('/');
      const name = `${decodeURIComponent(parsed[0]!)}/${decodeURIComponent(parsed[1]!)}`;
      const archive = archives.get(name)!;
      await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, archive);
      if (options?.checksum !== digest(archive)) throw new Error('SHA-256 不匹配');
      return { url, path, sha256: digest(archive), bytes: archive.length };
    },
  };
}

export async function fakeToolchain(root: string, channel: Channel): Promise<Toolchain> {
  for (const dir of ['bin', 'lib', 'include']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'bin', 'moon'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const expected = ['check', '--warn-list=-a', '-j', '1'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(91);
if (fs.existsSync('_build/old') || fs.existsSync('.mooncakes/old')) process.exit(92);
const data = JSON.parse(fs.readFileSync('behavior.json', 'utf8'));
const mode = data[${JSON.stringify(channel === 'stable' ? 'stable' : 'prerelease')}] || 'pass';
const home = process.env.MOON_HOME;
const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
console.log(JSON.stringify({env:process.env,cwd:process.cwd(),config}));
fs.mkdirSync('_build', {recursive:true}); fs.writeFileSync('_build/lane', ${JSON.stringify(channel)});
fs.mkdirSync(path.join(home,'cache'), {recursive:true});
fs.writeFileSync(path.join(home,'cache','lane'), ${JSON.stringify(channel)});
if (mode === 'crash') process.kill(process.pid, 'SIGKILL');
else if (mode === 'hang') { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); }
else { console.error(mode === 'warning' ? 'Warning: unused variable' : mode); process.exit(mode === 'fail' ? 1 : 0); }
`);
  await chmod(join(root, 'bin', 'moon'), 0o755);
  return { channel, distribution: channel === 'stable' ? 'latest' : 'pre-release', root, architecture: 'fixture', version: `fake-${channel}`, archives: [], setup: [] };
}

export async function readJson(path: string): Promise<Record<string, unknown>> { return JSON.parse(await readFile(path, 'utf8')); }
