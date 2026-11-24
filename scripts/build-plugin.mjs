import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const projectRoot = dirname(import.meta.dirname);
const distDir = join(projectRoot, 'dist');
const marketplaceName = 'fedex-local';
const marketplaceDir = join(distDir, 'codex-marketplace');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const manifest = await readJson(join(projectRoot, 'plugin.json'));
const { packages } = await readJson(join(projectRoot, 'package-lock.json'));
const productionDependencies = Object.entries(packages).filter(([path, dependency]) =>
  path.startsWith('node_modules/') && !dependency.dev,
);

for (const [path, { version }] of productionDependencies) {
  const installed = await readJson(join(projectRoot, path, 'package.json')).catch(() => null);
  if (installed?.version !== version) {
    throw new Error(`Run npm ci to install ${path} at version ${version}.`);
  }
}

await mkdir(distDir, { recursive: true });
const stage = await mkdtemp(`${marketplaceDir}-`);
try {
  const pluginPath = `./plugins/${manifest.name}`;
  const pluginDir = join(stage, pluginPath);
  const marketplaceConfigDir = join(stage, '.agents', 'plugins');
  await mkdir(pluginDir, { recursive: true });
  await mkdir(marketplaceConfigDir, { recursive: true });

  await cp(join(projectRoot, 'src'), join(pluginDir, 'src'), { recursive: true });
  await cp(join(projectRoot, 'package.json'), join(pluginDir, 'package.json'));
  await cp(join(projectRoot, 'plugin.json'), join(pluginDir, 'plugin.json'));
  for (const [path] of productionDependencies) {
    await cp(join(projectRoot, path), join(pluginDir, path), { recursive: true });
  }

  // Codex can launch from a desktop session where the build-time Node is absent from PATH.
  const nodeCommand = `'${process.execPath.replaceAll("'", "'\"'\"'")}'`;
  await writeFile(join(pluginDir, 'run-node'), `#!/bin/sh\nexec ${nodeCommand} "$@"\n`, { mode: 0o755 });

  await writeJson(join(pluginDir, 'mcp.json'), {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: {
      fedex: {
        type: 'stdio',
        command: './run-node',
        args: [`--env-file-if-exists=${join(projectRoot, '.env')}`, '${PLUGIN_ROOT}/src/index.js'],
        cwd: '${PLUGIN_ROOT}',
      },
    },
  });
  await writeJson(join(marketplaceConfigDir, 'marketplace.json'), {
    name: marketplaceName,
    interface: { displayName: 'FedEx Local' },
    plugins: [{
      name: manifest.name,
      source: { source: 'local', path: pluginPath },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: manifest.extensions['com.openai'].interface.category,
    }],
  });

  await rm(marketplaceDir, { recursive: true, force: true });
  await rename(stage, marketplaceDir);
} finally {
  await rm(stage, { recursive: true, force: true });
}

console.log(`Built ${manifest.name}@${marketplaceName} at ${marketplaceDir}`);
