#!/usr/bin/env node
// 把构建产物同步到一个 Windows 本地目录，供 DSH 以 link: 方式安装。
// 原因：DSH 读取插件元信息时不支持 UNC 路径（\\wsl.localhost\...），
// 必须给一个盘符绝对路径。源码仍留在 WSL，这里只放运行时需要的文件。
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stageDir = resolve(
  process.env.PIXEL_WALLPAPER_STAGE || '/mnt/e/Workspace/00-a-temp/dsh-pixel-wallpaper',
);

// 只同步运行时要用的东西；test/scripts/docs 不进暂存目录。
const ENTRIES = ['package.json', 'cordis.patch.yml', 'src', 'client', 'README.md', 'LICENSE'];

function runBuild() {
  execFileSync(process.execPath, [join(root, 'scripts', 'build-client.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
}

runBuild();

mkdirSync(stageDir, { recursive: true });

for (const entry of ENTRIES) {
  const from = join(root, entry);
  if (!existsSync(from)) throw new Error(`缺少 ${entry}，无法暂存`);
  const to = join(stageDir, entry);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

const rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(
  join(stageDir, '.stage.json'),
  JSON.stringify({ from: root, rev, at: new Date().toISOString() }, null, 2) + '\n',
);

console.log(`[pixel-wallpaper] 已暂存到 ${stageDir}（${rev}）`);
