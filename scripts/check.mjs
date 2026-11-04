import { readFile, stat, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConfig } from '../portal/js/config.js';
import {loadAppIntegrations} from './app-integrations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function validateWorkspace(root = ROOT) {
  const raw = JSON.parse((await readFile(path.join(root, 'portal/config/apps.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const config = validateConfig(raw);
  const warnings = [];
  const applications = await loadAppIntegrations(root);
  for (const app of config.apps.filter(app => app.status === 'ready')) {
    if (applications[app.id]?.type === 'static') {
      if (app.url !== `/${app.id}/`) throw new Error(`静态应用 ${app.id} 的地址与本地/IIS 挂载不一致`);
      const filename = path.join(applications[app.id].root, applications[app.id].entry);
      let info;
      try { info = await stat(filename); } catch { throw new Error(`应用 ${app.id} 标记 ready，但缺少接入配置指定的发布 HTML`); }
      if (!info.isFile() || info.size === 0) throw new Error(`应用 ${app.id} 的发布 HTML 为空或不是文件`);
    } else {
      warnings.push(`${app.id} 已标记 ready；配置检查不启动其独立服务；需验证页面与接口，内网部署另行验收。`);
    }
  }
  return { config, warnings };
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(filename));
    else if (/\.(?:m?js)$/.test(entry.name)) files.push(filename);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await validateWorkspace();
    const files = (await Promise.all(['portal/js', 'scripts', 'tests'].map(directory => sourceFiles(path.join(ROOT, directory))))).flat();
    for (const filename of files) {
      const check = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
      if (check.error || check.status !== 0) throw new Error(check.error?.message || check.stderr);
    }
    for (const warning of result.warnings) console.warn(warning);
    console.log(`检查通过：${result.config.apps.length} 个已启用应用，${files.length} 个 JavaScript 文件。`);
  } catch (error) {
    console.error(`检查失败：${error.message}`);
    process.exitCode = 1;
  }
}
