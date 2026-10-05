# 《吊灯》小说站说明

这是一个基于 Astro 的轻小说阅读站，英文名沿用父文件夹名称：

- English: Chandelier In the Midnight with an Idoit and a Cup
- Chinese: 《吊灯》

项目的核心结构是：

```text
Novel-blog/
├── README.md
├── package.json
├── public/
│   └── music/
├── src/
│   ├── content.config.ts
│   ├── content/
│   │   └── novels/
│   │       ├── 第一卷/
│   │       ├── 第二卷/
│   │       └── ...
│   └── pages/
│       ├── index.astro
│       └── Novels/
│           └── [...slug].astro
└── start.bat
```

## 1. 这几个名字分别代表什么

- 英文名：来自父文件夹名，作为小说的英文标题
- 中文名：统一写作 《吊灯》
- 卷名：例如 第一卷、第二卷、第三卷
- 章节名：例如 第01章、第02章

目录中的章节文件应当保持清晰统一，推荐命名格式如下：

```text
src/content/novels/第一卷/第01章.md
src/content/novels/第二卷/第02章.md
```

每个章节文件都需要带上 front matter：

```md
---
title: "第一卷第1章"
part: "第一卷"
chapter: 1
---
```

如果没有这些字段，Astro 会把它视为无效内容，导致构建失败。

## 2. 我现在的更新流程

### 每次新增章节时

1. 进入 `src/content/novels/` 目录
2. 找到对应卷名文件夹，例如 `第一卷`
3. 新增一个章节文件，命名为 `第XX章.md`
4. 在文件头部写入 front matter：

```md
---
title: "第1章"
part: "第一卷"
chapter: 1
---
```

5. 章节正文直接写在 front matter 后面
6. 保存后，网站会在首页和章节列表中自动识别

### 每次修改样式时

- 主页样式在 `src/pages/index.astro`
- 阅读页样式在 `src/pages/Novels/[...slug].astro`
- 内容收集规则在 `src/content.config.ts`

### 本地预览

在项目根目录运行：

```sh
npm install
npm run dev
```

然后打开浏览器访问：

```text
http://localhost:4321
```

### 构建部署

```sh
npm run build
```

如需部署到 Cloudflare Pages，请将生成的静态文件部署过去，音乐文件可放到：

```text
public/music/
```

支持的音频格式包括 MIDI、MP3、WAV、OGG、FLAC 等。部署后，页面会自动扫描这些静态文件并在左侧音乐播放器中列出可选项。

## 3. 注意事项

- 不要把无关的 `.md` 文件放进 `src/content/novels/` 目录
- 例如 `test.md`、临时草稿、未命名的文件都可能被误识别
- 章节名必须符合 `第XX章.md` 这种格式
- 若内容不规范，Astro 会在构建时报 `InvalidContentEntryDataError`

## 4. 如果你想继续更新

最重要的原则只有一句：

> 只在 `src/content/novels/` 里放正式章节，页面会自动读取，不用手动维护目录列表。

如果你愿意，我下一步可以继续帮你做两件事中的任意一件：

1. 继续优化首页/阅读页视觉细节，做得更“文学感”一点
2. 帮你整理一份章节模板文件，后面每次新增章节只复制粘贴即可
