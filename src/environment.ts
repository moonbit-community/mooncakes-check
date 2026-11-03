import { access, cp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IndexSnapshot, Toolchain } from './types.js';

export function isolatedEnvironment(moonHome: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(MOON|CCACHE_|SCCACHE_|CARGO_|RUSTC_|GIT_)/.test(key) ||
        ['CC', 'CXX', 'AR', 'CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'RUSTFLAGS', 'RUSTC', 'RUSTC_WRAPPER',
          'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'TAR_OPTIONS', 'TMP', 'TEMP'].includes(key)) delete env[key];
  }
  env.MOON_HOME = moonHome;
  env.PATH = [join(moonHome, 'bin'), ...(base.PATH ?? '/usr/bin:/bin').split(delimiter).filter(p => isAbsolute(p) && p !== join(moonHome, 'bin'))].join(delimiter);
  env.XDG_CACHE_HOME = join(moonHome, 'cache', 'xdg');
  env.XDG_CONFIG_HOME = join(moonHome, 'config');
  env.XDG_DATA_HOME = join(moonHome, 'data');
  env.TMPDIR = join(moonHome, 'tmp');
  env.NO_COLOR = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

export async function prepareHome(toolchain: Toolchain, home: string, index: IndexSnapshot): Promise<NodeJS.ProcessEnv> {
  await mkdir(home, { recursive: true });
  for (const dir of ['bin', 'lib', 'include']) {
    const source = join(toolchain.root, dir);
    await access(source);
    await symlink(source, join(home, dir), 'dir');
  }
  for (const dir of ['registry', 'tmp']) await mkdir(join(home, dir), { recursive: true });
  const indexUrl = pathToFileURL(index.path).href;
  // Own copy of the checkout (including .git), so a dependency-triggered fetch
  // only resets this check's copy, against the immutable local run snapshot.
  await cp(index.path, join(home, 'registry', 'index'), { recursive: true, dereference: false });
  // Write origin directly through git in the caller, since libgit2 also checks
  // the remote URL before deciding whether to replace its checkout.
  await writeFile(join(home, 'config.json'), JSON.stringify({
    registry: 'https://mooncakes.io', api: 'https://mooncakes.io',
    download: 'https://download.mooncakes.io', index: indexUrl,
  }, null, 2));
  return isolatedEnvironment(home);
}
