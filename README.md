# 文件管理系统

本地文件浏览、预览与批量操作工具，基于 Node.js + Express。

## 功能

### 文件浏览

- 左侧目录树浏览文件结构
- 支持自定义根目录路径（自动记忆）

### 文件预览

- **Word (.docx)** — 原样视图 + 阅读视图，支持目录导航和内容搜索定位
- **Excel (.xlsx)** — 多 Sheet 切换，表格样式保留
- **文本/日志** — 语法高亮，日志搜索
- **图片** — 直接预览

### 批量操作

- **移动撤回文件** — 将文件名包含"撤回"的音频文件移动到撤回文件夹
- **查找关键词文档** — 搜索 Word 文档中同时包含"返场故事"和"撤回"的文件，支持点击跳转预览
- **删除返场故事内容** — 删除匹配文档中指定行及后续内容，原文件自动备份

所有批量操作支持实时进度显示。

### 操作日志

- 每次批量操作自动记录日志
- 按日期分文件存储，可视化查看

## 快捷键

| 快捷键 | 功能 |
| -------- | ------ |
| `Ctrl+F` | 聚焦 Word 搜索框 |
| `Esc` | 关闭弹窗 / 取消确认 |
| `Enter` | Word 搜索框内回车执行搜索 |

## 技术栈

- **后端** — Node.js, Express
- **前端** — 原生 HTML/CSS/JS，单文件
- **依赖** — mammoth (Word解析), xlsx (Excel解析), jszip (docx操作)

## 项目结构

```text
ming-story/
├── server.js              # 后端服务（Express）
├── index.html             # 前端页面（单文件，原生 HTML/CSS/JS）
├── package.json           # 依赖配置
├── start.bat              # 启动脚本（带命令行窗口）
├── 启动文件管理系统.vbs     # 静默启动脚本（无黑窗）
└── build/                 # 打包工具
    ├── build-portable.js  # 打包脚本（Node.js）
    └── build.cmd          # 打包快捷入口（双击运行）
```

## 启动（开发环境）

需要本机已安装 Node.js。

```bash
# 1. 安装依赖
npm install

# 2. 启动服务（三选一）
npm start                  # 命令行启动
start.bat                  # 双击启动（带命令行窗口）
启动文件管理系统.vbs         # 双击启动（无黑窗）
```

启动后自动打开浏览器访问 `http://localhost:3000`，默认管理上级目录的文件。

## 打包发布（免安装便携版）

打包后生成一个完全独立的文件夹，包含内置的 Node.js 运行时，用户无需安装任何软件。

### 打包步骤

```bash
# 在 build 目录下运行（或双击 build.cmd）
node build/build-portable.js
```

打包过程会**自动处理**以下步骤：

1. 下载便携版 Node.js（约 30MB，需联网，仅首次）
2. 解压 Node.js 到 `runtime/` 目录
3. 复制项目文件（server.js、index.html 等）
4. 用 npm 安装生产依赖
5. 生成启动脚本和使用说明

打包输出在 `dist/file-manager/` 目录。

### 打包产物结构

```text
dist/file-manager/
├── runtime/           # 内置 Node.js 运行时（免安装）
├── node_modules/      # 生产依赖
├── server.js          # 后端服务
├── index.html         # 前端页面
├── package.json       # 依赖配置
├── start.bat          # 用户启动入口（带命令行窗口）
├── start-silent.vbs   # 用户启动入口（无黑窗）
└── README.txt         # 使用说明
```

## 用户使用（免安装便携版）

1. 收到压缩包后解压
2. 将 `file-manager` 文件夹放到要管理的目录中（系统会自动管理其**上级目录**的文件）
3. 双击 `start.bat` 启动，浏览器自动打开
4. 关闭命令行窗口即停止服务

> **无需安装 Node.js，无需联网，解压即用。**
