import { chmod, mkdir, readdir, readFile, lstat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { download } from './download.js';
import { isolatedEnvironment } from './environment.js';
import { requireSuccess, runProcess } from './process.js';
import { atomicWrite } from './io.js';
import type { Channel, Toolchain } from './types.js';

export function toolchainUrls(channel: Channel, architecture = process.arch, base = 'https://cli.moonbitlang.com'): {
  binary: string; core: string; architecture: string;
} {
  const arch = ({ x64: 'x86_64', arm64: 'aarch64' } as Record<string, string>)[architecture];
  if (!arch) throw new Error(`不支持的 Linux 架构: ${architecture}`);
  const distribution = channel === 'stable' ? 'latest' : 'pre-release';
  return { binary: `${base}/binaries/${distribution}/moonbit-linux-${arch}.tar.gz`,
    core: `${base}/cores/core-${distribution}.tar.gz`, architecture: arch };
}

export async function installToolchain(channel: Channel, workDir: string, outputDir: string, signal?: AbortSignal,
  base?: string): Promise<Toolchain> {
  const urls = toolchainUrls(channel, process.arch, base);
  const root = join(workDir, 'toolchains', channel);
  const logs = join(outputDir, 'logs', 'toolchains', channel);
  const archiveDir = join(outputDir, 'toolchains', channel);
  for (const dir of [root, join(root, 'lib'), join(root, 'tmp')]) await mkdir(dir, { recursive: true });
  const toolchain: Toolchain = { channel, distribution: channel === 'stable' ? 'latest' : 'pre-release',
    root, architecture: urls.architecture, version: '', archives: [], setup: [] };
  const env = isolatedEnvironment(root);
  const command = async (program: string, args: string[], name: string, cwd = root) => {
    const result = await runProcess({ command: program, args, cwd, env, logPrefix: join(logs, name), timeoutMs: 300_000, signal });
    toolchain.setup.push(result);
    requireSuccess(result);
    return result;
  };
  try {
    const binaries = await download(urls.binary, join(archiveDir, 'toolchain.tar.gz'), { signal });
    toolchain.archives.push(binaries);
    await command('tar', ['xf', binaries.path, '--no-same-owner', '--no-same-permissions', '--directory', root], 'extract-toolchain');
    async function executableFiles(directory: string): Promise<void> {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) await executableFiles(path);
        else if (item.isFile()) await chmod(path, 0o755);
      }
    }
    await executableFiles(join(root, 'bin'));
    try { await lstat(join(root, 'bin', 'moonx')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await symlink('moon', join(root, 'bin', 'moonx'));
    }
    const core = await download(urls.core, join(archiveDir, 'core.tar.gz'), { signal });
    toolchain.archives.push(core);
    await command('tar', ['xf', core.path, '--no-same-owner', '--no-same-permissions', '--directory', join(root, 'lib')], 'extract-core');
    const moon = join(root, 'bin', 'moon');
    const version = await command(moon, ['version', '--all'], 'version');
    toolchain.version = (await readFile(version.stdoutLog, 'utf8')).trim();
    if (!toolchain.version) throw new Error(`${channel} 未返回工具链版本`);
    // Match the official Unix installer, including the final wasm-gc bundle.
    await command(moon, ['bundle', '--warn-list=-a', '--all'], 'bundle-all', join(root, 'lib', 'core'));
    await command(moon, ['bundle', '--warn-list=-a', '--target', 'wasm-gc', '--quiet'], 'bundle-wasm-gc', join(root, 'lib', 'core'));
    return toolchain;
  } finally {
    // Also preserve hashes/version/setup outcomes when installation fails.
    await atomicWrite(join(archiveDir, 'toolchain.json'), JSON.stringify(toolchain, null, 2) + '\n');
  }
}
