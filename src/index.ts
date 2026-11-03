import { readdir, readFile, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { valid, rcompare } from 'semver';
import { retry } from './download.js';
import { message } from './io.js';
import { requireSuccess, runProcess } from './process.js';
import type { Config, IndexSnapshot, Release, RunError } from './types.js';

export const INDEX_URL = 'https://mooncakes.io/git/index';
export const DOWNLOAD_URL = 'https://download.mooncakes.io';

export function validModuleName(name: string): boolean {
  const parts = name.split('/');
  return parts.length >= 2 && parts.every(part => /^[\p{L}\p{N}\p{S}_][\p{L}\p{N}\p{M}\p{S}_.-]*$/u.test(part));
}

// The official client encodes the owner and the *entire* unqualified module
// name separately; nested module names must keep their slash percent-encoded.
export function packageUrl(name: string, version: string, base = DOWNLOAD_URL): string {
  if (!validModuleName(name) || !valid(version)) throw new Error('无效模块名或版本');
  const slash = name.indexOf('/');
  const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${base}/user/${encode(name.slice(0, slash))}/${encode(name.slice(slash + 1))}/${encode(version)}.zip`;
}

interface Entry { name: string; version: string; checksum: string; createdAt: string; yanked: boolean }

function parseEntry(value: unknown, name: string): Entry | undefined {
  if (!value || typeof value !== 'object') throw new Error('条目必须是 JSON 对象');
  const row = value as Record<string, unknown>;
  // Historical records without publication time are excluded completely,
  // including from latest-version selection (explicit scanner policy).
  if (row.created_at === undefined || row.created_at === null || row.created_at === '') return undefined;
  if (row.name !== name || !validModuleName(name)) throw new Error('模块名与索引路径不一致');
  if (typeof row.version !== 'string' || !valid(row.version) || /^[v=\s]/.test(row.version)) throw new Error('无效 SemVer');
  if (typeof row.checksum !== 'string' || !/^[a-f\d]{64}$/i.test(row.checksum)) throw new Error('无效 SHA-256');
  if (typeof row.created_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.created_at) ||
      !Number.isFinite(Date.parse(row.created_at))) throw new Error('无效或缺少时区的 created_at');
  if (row.yanked !== undefined && typeof row.yanked !== 'boolean') throw new Error('无效 yanked');
  return { name, version: row.version, checksum: row.checksum.toLowerCase(), createdAt: row.created_at, yanked: row.yanked === true };
}

export function selectRelease(jsonl: string, name: string, now: Date, days: number): Release | undefined {
  const versions = new Map<string, Entry>();
  for (const [line, text] of jsonl.split('\n').entries()) {
    if (!text.trim()) continue;
    try {
      const entry = parseEntry(JSON.parse(text), name);
      if (!entry) continue;
      // Later records override earlier records (including yanks).
      versions.set(entry.version, entry);
    } catch (error) { throw new Error(`第 ${line + 1} 行: ${message(error)}`); }
  }
  const releases = [...versions.values()].filter(e => !e.yanked && Date.parse(e.createdAt) <= now.getTime());
  const cutoff = now.getTime() - days * 86_400_000;
  const recent = releases.filter(e => Date.parse(e.createdAt) >= cutoff)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!recent) return undefined;
  const newest = releases.sort((a, b) => rcompare(a.version, b.version) || a.version.localeCompare(b.version))[0]!;
  return { name, version: newest.version, checksum: newest.checksum, createdAt: newest.createdAt, recentReleaseAt: recent.createdAt };
}

export async function selectPackages(indexDir: string, config: Config, now: Date, signal?: AbortSignal): Promise<{
  packages: Release[]; eligible: number; errors: RunError[];
}> {
  const selected: Release[] = [];
  const errors: RunError[] = [];
  const root = join(indexDir, 'user');
  async function walk(directory: string): Promise<void> {
    for (const file of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const path = join(directory, file.name);
      if (file.isDirectory()) await walk(path);
      else if (file.name.endsWith('.index')) {
        const name = relative(root, path).split(sep).join('/').slice(0, -6);
        try {
          if (!file.isFile()) throw new Error('索引条目不是普通文件');
          const release = selectRelease(await readFile(path, 'utf8'), name, now, config.days);
          if (release) selected.push(release);
        } catch (error) { errors.push({ stage: `index:${name}`, message: message(error) }); }
      }
    }
  }
  await walk(root);
  selected.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const filtered = selected.filter(p => !config.packages.length || config.packages.includes(p.name));
  for (const name of config.packages) {
    if (!filtered.some(p => p.name === name)) errors.push({ stage: 'selection', message: `${name} 不在近 ${config.days} 天未撤回发布的筛选结果中` });
  }
  return { packages: filtered.slice(0, config.limit), eligible: selected.length, errors };
}

export async function cloneIndex(path: string, logDir: string, signal?: AbortSignal, url = INDEX_URL): Promise<IndexSnapshot> {
  await retry(async attempt => {
    await rm(path, { recursive: true, force: true });
    const result = await runProcess({ command: 'git', args: ['clone', '--depth=1', '--single-branch', '--branch', 'main', '--no-tags', '--', url, path],
      cwd: process.cwd(), logPrefix: join(logDir, `index-clone-${attempt}`), timeoutMs: 120_000, signal });
    requireSuccess(result);
  }, signal);
  const revision = await runProcess({ command: 'git', args: ['-C', path, 'rev-parse', 'HEAD'], cwd: path,
    logPrefix: join(logDir, 'index-revision'), timeoutMs: 10_000, signal });
  requireSuccess(revision);
  const commit = (await readFile(revision.stdoutLog, 'utf8')).trim();
  if (!/^[a-f\d]{40,64}$/.test(commit)) throw new Error('无效的索引提交号');
  return { url, path, commit };
}
