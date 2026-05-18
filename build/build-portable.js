const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const APP_DIR = path.join(DIST_DIR, 'file-manager');
const NODE_DIR = path.join(APP_DIR, 'runtime');
const NODE_VERSION = 'v20.18.1';
const NODE_ZIP = `node-${NODE_VERSION}-win-x64.zip`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}`;
const NODE_ZIP_PATH = path.join(DIST_DIR, NODE_ZIP);

function log(msg) { console.log(msg); }

function mkdirp(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDirSync(src, dest) {
  mkdirp(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    log(`       下载中: ${url}`);
    const file = fs.createWriteStream(dest);
    const request = (reqUrl) => {
      https.get(reqUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          request(response.headers.location);
          return;
        }
        const total = parseInt(response.headers['content-length'] || '0');
        let downloaded = 0;
        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = Math.round(downloaded / total * 100);
            process.stdout.write(`\r       进度: ${pct}% (${Math.round(downloaded/1024/1024)}MB / ${Math.round(total/1024/1024)}MB)  `);
          }
        });
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('');
          resolve();
        });
      }).on('error', (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
    };
    request(url);
  });
}

async function main() {
  log('============================================');
  log('  文件管理系统 - 便携版打包工具');
  log('============================================');
  log('');

  // [1/5] 清理 & 创建目录
  if (fs.existsSync(DIST_DIR)) {
    log('[1/5] 清理旧的构建目录...');
    rmrf(DIST_DIR);
  }
  log('[1/5] 创建目录结构...');
  mkdirp(APP_DIR);
  mkdirp(NODE_DIR);

  // [2/5] 下载 Node.js
  log(`[2/5] 下载便携版 Node.js ${NODE_VERSION}...`);
  log('       (约30MB，请耐心等待)');
  if (!fs.existsSync(NODE_ZIP_PATH)) {
    try {
      await downloadFile(NODE_URL, NODE_ZIP_PATH);
      log('       下载完成！');
    } catch (e) {
      log(`[错误] 下载失败: ${e.message}`);
      log(`       请手动下载: ${NODE_URL}`);
      log(`       放到 ${DIST_DIR} 目录下后重新运行`);
      process.exit(1);
    }
  } else {
    log('       已有缓存，跳过下载');
  }

  // [3/5] 解压 Node.js
  log('[3/5] 解压 Node.js...');
  const tempDir = path.join(DIST_DIR, 'temp_node');
  mkdirp(tempDir);
  execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${NODE_ZIP_PATH}' -DestinationPath '${tempDir}' -Force"`, { stdio: 'inherit' });
  const extractedDir = path.join(tempDir, `node-${NODE_VERSION}-win-x64`);
  copyDirSync(extractedDir, NODE_DIR);
  rmrf(tempDir);
  log('       解压完成！');

  // [4/5] 复制项目文件
  log('[4/5] 复制项目文件...');
  const filesToCopy = ['server.js', 'index.html', 'package.json', 'package-lock.json'];
  for (const f of filesToCopy) {
    const src = path.join(PROJECT_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(APP_DIR, f));
    }
  }

  // 始终用打包自带的 npm 重新安装依赖（避免 pnpm 符号链接复制问题）
  log('       安装依赖（使用 npm install）...');
  const npmCmd = path.join(NODE_DIR, 'npm.cmd');
  execSync(`"${npmCmd}" install --omit=dev`, { cwd: APP_DIR, stdio: 'inherit' });
  log('       复制完成！');

  // [5/5] 创建启动脚本
  log('[5/5] 创建启动脚本...');

  // start.bat
  const startBat = `@echo off\r\nchcp 65001 >nul\r\ncd /d "%~dp0"\r\necho.\r\necho   文件管理系统启动中...\r\necho   启动后请勿关闭此窗口\r\necho.\r\n"%~dp0runtime\\node.exe" "%~dp0server.js"\r\npause\r\n`;
  fs.writeFileSync(path.join(APP_DIR, 'start.bat'), startBat, 'utf8');

  // start-silent.vbs
  const startVbs = `Set ws = CreateObject("WScript.Shell")\r\nws.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)\r\nws.Run "runtime\\node.exe server.js", 0, False\r\nWScript.Sleep 1500\r\nws.Run "http://localhost:3000"\r\n`;
  fs.writeFileSync(path.join(APP_DIR, 'start-silent.vbs'), startVbs, 'utf8');

  // README
  const readme = `文件管理系统 - 使用说明\r\n\r\n启动方法:\r\n  - 双击 start.bat 启动（会显示命令行窗口，关闭窗口即停止服务）\r\n  - 双击 start-silent.vbs 静默启动（无黑窗，自动打开浏览器）\r\n\r\n停止方法:\r\n  - 用 start.bat 启动的：关闭命令行窗口即可\r\n  - 用 start-silent.vbs 启动的：打开任务管理器，结束 node.exe 进程\r\n\r\n注意事项:\r\n  - 无需安装任何软件，解压即用\r\n  - 默认管理本文件夹的上级目录中的文件\r\n  - 浏览器访问地址: http://localhost:3000\r\n`;
  fs.writeFileSync(path.join(APP_DIR, 'README.txt'), readme, 'utf8');

  // 清理下载缓存
  try { fs.unlinkSync(NODE_ZIP_PATH); } catch(e) {}

  log('');
  log('============================================');
  log('  打包完成！');
  log('============================================');
  log('');
  log(`  输出目录: ${APP_DIR}`);
  log('');
  log('  使用方法:');
  log('    1. 将 dist/file-manager 文件夹压缩成 zip');
  log('    2. 发给用户，解压后双击 start.bat 即可');
  log('    3. 或双击 start-silent.vbs 无黑窗启动');
  log('');
  log('  用户无需安装任何软件！');
  log('============================================');
}

main().catch(e => {
  console.error('打包失败:', e.message);
  process.exit(1);
});
