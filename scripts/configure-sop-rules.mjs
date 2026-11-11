// Save a path to an existing private SOP rules file. Business rules remain source-owned.
import {readFile, writeFile, mkdir, realpath, stat, open, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseArgs} from 'node:util';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readOptional(filename) {
  try { return await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function configureSopRules(root, selectedFile) {
  root = await realpath(root);
  const filename = path.resolve(root, selectedFile);
  const info = await stat(filename);
  if (!info.isFile() || !info.size || path.extname(filename).toLowerCase() !== '.py') {
    throw new Error('请选择已有的非空 Python 规则文件。');
  }
  const configDirectory = path.join(root, 'config.local');
  await mkdir(configDirectory, {recursive: true});
  if (await realpath(configDirectory) !== configDirectory) {
    throw new Error('本机配置目录不能重定向到其他位置。');
  }
  const lockPath = path.join(configDirectory, 'sop-rules.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('另一个规则配置操作尚未结束，请稍后重试。');
    throw error;
  }
  let temporary;
  try {
    const configPath = path.join(configDirectory, 'sop.json');
    const previous = await readOptional(configPath);
    const config = previous === null ? {} : JSON.parse(previous.replace(/^\uFEFF/, ''));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('config.local/sop.json 必须为对象，请先修复现有配置。');
    }
    const relative = path.relative(root, filename);
    if (path.isAbsolute(relative)) {
      throw new Error('规则文件与门户位于不同磁盘，请先放到同一磁盘以便保存相对路径。');
    }
    const sharedConfig = relative.split(path.sep).join('/');
    if (config.sharedConfig === sharedConfig) return {sharedConfig, backup: null};
    config.sharedConfig = sharedConfig;
    let backup = null;
    if (previous !== null) {
      const artifacts = path.join(root, 'artifacts');
      await mkdir(artifacts, {recursive: true});
      if (await realpath(artifacts) !== artifacts) throw new Error('备份目录不能重定向到其他位置。');
      backup = path.join(artifacts, 'sop-config-' + crypto.randomUUID() + '.json');
      await writeFile(backup, previous);
    }
    temporary = configPath + '.' + crypto.randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n');
    if (await readOptional(configPath) !== previous) throw new Error('配置已被其他操作修改，请重试。');
    await rename(temporary, configPath);
    temporary = null;
    return {sharedConfig: config.sharedConfig, backup};
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const {values} = parseArgs({options: {rules: {type: 'string'}, help: {type: 'boolean'}}});
    if (values.help) {
      console.log('node scripts/configure-sop-rules.mjs [--rules <已有规则文件>]\n相对路径以门户根目录为准。');
    } else {
      let selected = values.rules;
      if (selected === undefined) {
        console.log('请先在内网找到或迁入真实的 shared_config.py。该业务配置不随 Git 下载。');
        const prompt = createInterface({input: process.stdin, output: process.stdout});
        try { selected = await prompt.question('将规则文件拖入此窗口，或输入文件路径后按回车：'); }
        finally { prompt.close(); }
      }
      selected = selected.trim().replace(/^"(.*)"$/, '$1');
      if (!selected) throw new Error('尚未选择规则文件。');
      const result = await configureSopRules(ROOT, selected);
      console.log('规则路径已保存：' + result.sharedConfig);
      if (result.backup) console.log('原配置备份：' + path.relative(ROOT, result.backup));
      console.log('重新双击“启动本地门户.cmd”。规则内容由 SOP 在启动时校验。');
      if (process.env.SOP_SHARED_CONFIG) console.log('当前设置了 SOP_SHARED_CONFIG 环境变量，它的优先级高于本机配置，请一并核对。');
    }
  } catch (error) {
    console.error('规则路径配置未完成：' + error.message);
    process.exitCode = 1;
  }
}
