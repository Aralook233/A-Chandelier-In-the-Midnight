# 《吊灯》小说站

一个中文轻小说阅读站：Astro 静态构建，部署在 Cloudflare Pages；登录与留言是 Pages Functions + Workers KV，没有数据库。

- 英文名沿用仓库名：Chandelier In the Midnight with an Idoit and a Cup
- 中文名统一写作：《吊灯》

页面一共四类：章节阅读（`/novels/…`，带阅读进度与订阅源）、留言板（登录后发言，管理员可删）、`/studio/`（一个零依赖的浏览器 DAW，见第 9 节），以及首页那台 80 年代收音机（794 首曲目从私有 KV 流式播放，见第 8 节）。

技术栈：Astro 7（`output: 'static'`）· Cloudflare Pages + Functions + KV · 无前端框架 · 无 SQL · 无 CSS 框架 · Node `>= 22.12`。全站自托管一个按 `unicode-range` 拆分的仿宋（FandolFang）webfont（见第 4 节），字体许可证是 GPL-2.0 加字体嵌入例外。

## 1. 跑起来

```sh
npm install
npm run dev        # http://localhost:4321，只监听 127.0.0.1
npm run build      # 输出 dist/
npm run verify     # build + CSP 守卫 + 105 条后端安全测试 + 77 条电台路由测试
npm run test:functions  # 只跑后端那 105 条（对着内存 KV mock 打真实 handler）
npm run test:track      # 只跑电台那 77 条
npm run icons           # 重新生成 PWA / Apple 图标
```

要 Node `>= 22.12`（`package.json` 的 `engines`），没有 TypeScript 构建步骤——`.ts` 由 Astro/Vite 处理，`functions/` 里全是 `.js`。

根目录的 `start.bat` 等价于 `npm run dev`。**不要把 dev server 改成 `--host 0.0.0.0`**：那会把带源码和错误栈的开发服务暴露到局域网。

`astro dev` 不加载 `functions/`，本地调接口（包括 `/track/<id>`）要用 `wrangler pages dev dist`，凭证放 `.dev.vars`；本站日常开发不依赖这一步。

## 2. 目录

```text
Novel-blog/
├── astro.config.mjs            # 静态输出、inlineStylesheets:'never'、两个 remark 插件
├── functions/                  # Cloudflare Pages Functions（路由按文件路径自动挂载）
│   ├── _lib/security.js        # 输入清洗、PBKDF2、会话签名、限流桶
│   ├── _lib/accounts.js        # 用户表（KV 单键 + CAS）、会话吊销
│   ├── _lib/purge.js           # 删贴后清 CDN 缓存（可选能力）
│   ├── track/[id].js           # 电台音频路由：从 KV 的分片里拼出 Range 区间
│   └── api/auth.js · api/discussions.js
├── public/
│   ├── _headers                # CSP、缓存策略、机器人限制头——安全头的唯一来源
│   ├── fonts/                  # tools/font_faces.py 生成的 woff2 子集（内容哈希命名）+ 两份许可证
│   ├── icons/ · manifest.webmanifest · .well-known/security.txt
│   └── music/                  # 只剩一份说明，音频本体不在仓库（见第 8 节）
├── src/
│   ├── content/novels/第一卷/第01章.md …
│   ├── content.config.ts       # 章节 schema
│   ├── data/music.mjs          # 生成物：794 首的节目单，含库内路径 key，绝不下发给浏览器
│   ├── plugins/remark-*.mjs    # 自然段与中文标点排版
│   ├── pages/index.astro · 404.astro · Novels/[...slug].astro · studio.astro · rss.xml.js
│   ├── pages/music/tracks.json.js   # 电台在打开节目单时才 fetch 的白名单字段
│   ├── components/RadioPlayer.astro
│   ├── scripts/discussion-moderation.js
│   ├── styles/                 # story-font / story-typography / homepage-motion / moderation / studio
│   ├── utils/                  # sanitize.ts · theme.ts · tesseract.ts · midi.ts · studio/（见第 9 节）
│   └── pages/…（每个页面的样式写在它自己的 <style> 里）
├── tests/                      # functions.security.test.mjs（105）· track.test.mjs（77）
└── tools/                      # 见第 4、8 节：csp-guard · font_faces · music_manifest · music_kv_put · make-icons
```

## 3. 写章节

文件放 `src/content/novels/<卷名>/第XX章.md`，front matter 必填前三项：

```md
---
title: "第1章"
part: "第一卷"
chapter: 1
published: "2026-10-08"
---
```

`published` 可选，但**要进订阅源就得手写**。RSS 的 `pubDate` 只信这个字段，不信文件时间：git 检出不保存 mtime，构建机上所有章节的时间都等于那次 checkout 的时刻，用它会让你每次部署都把全部旧章节重推一遍。缺日期的条目不输出 `pubDate`，按卷章倒序排在有日期的条目后面（规则见 `src/pages/rss.xml.js` 头部注释）。

正文排版由两个 remark 插件负责，`astro.config.mjs` 里那行 `remarkPlugins` 和样式层的 `story-typography.css` 是配套的，删任一边都会让段落合并或标点悬挂失效。别把草稿、`test.md` 一类的文件放进 `src/content/novels/`——不符合 schema 的内容会让构建报 `InvalidContentEntryDataError`。

## 4. 字体：改过正文就要重跑

站点正文用仿宋 FandolFang（要的就是那副铅字排出来的样子），许可证是 GPL-2.0 加字体嵌入例外，说明在 `/fonts/FANDOL-LICENCE.txt`，许可证全文 `/fonts/GPL-2.0.txt`。它被拆成同一个家族的三片 `unicode-range`，`public/fonts/` 里现在有三片：

- `fandol-core`（0.50 MB，1,273 个字）：正文会渲染的每一个字形，首次访问下载
- `fandol-music`（0.41 MB，1,063 个字）：只有节目单的行能碰到的字（曲名、作者、盘架、风格）；不点电台的读者不会下载它，点开的也不用去拉下面那片
- `fandol-fill`（2.53 MB，5,351 个字）：GB2312 剩下的部分，只有页面遇到前两片画不出来的字时才请求

794 条曲名连作者、盘架、风格标签一起摊开是 1,860 个字种，其中 1,026 个正文用不到——把它们并进 core 会让每个只来读小说的人多下载 0.41 MB，所以单开一面。实测现在的正文和节目单都不再触发 fill（只有 8 个 emoji 落到系统表情字体，那是本来就该它们接的）；fill 是将来加新章节时的保底，一旦触发就是 2.53 MB，所以**新字要尽早重跑工具收进 core 或 music**。

仿宋比原来的楷体重：Fandol 一个字形平均约 410 B，core 因此从 0.21 MB 涨到 0.50 MB。`font-display: swap` 保证首屏先用系统的仿宋/宋体画出来，字体到了再换。

生成顺序是**构建 → 切片 → 再构建**，因为角色集要读 `dist/**.html`（Markdown 会把直引号换成 `“ ”`，只扫源码会漏字）：

```sh
npm run build
py -3 tools/font_faces.py D:\path\to\FandolFang-Regular.otf
npm run build
```

`FandolFang-Regular.otf` 不进仓库（`.gitignore` 里有 `*.ttf` 和 `*.otf`），从上游 CTAN 下载：http://www.ctan.org/tex-archive/fonts/fandol ；切片要 `fontTools` 与 brotli：`py -3 -m pip install fonttools brotli`。`tools/font_faces.py` 的 `SUFFIXES` 含 `.json`，`music_chars()` 又读 `src/data/music.mjs` 的 `title/artist/album/side/genre` 五个字段，所以**加过章节或换过节目单就要重跑**，否则新字会去拉那 2.53 MB 的 fill 面。文件名内嵌内容哈希，因此 `public/_headers` 里 `/fonts/*` 可以安全地 `max-age=31536000, immutable`。

Fandol 不是全覆盖：正文里 9 个字形（`«»↔−⏏▶◀♯❚`）和曲名里 91 个字（日韩汉字、带变音的拉丁字母、谚文、emoji）它本身没有，浏览器会顺着 `--font-story` 往后找，所以链尾留了 `'Segoe UI Symbol', 'Apple Symbols'`——少了这两个，收音机上的播放/暂停键会变成豆腐块。

三个坑，别再踩：一个 range 的上界**不能再带 `U+`**（`U+20-7e` 正确，`U+20-U+7e` 整条描述符会被浏览器静默丢弃，于是两面都变成覆盖全码位、每次访问都下载 3 MB 出头）；同一家族的几面必须**互不相交**（脚本里的 `carve()` 就是干这个的），否则重叠的 `unicode-range` 让浏览器把两面都拉下来，拆分等于白做；`tools/music_manifest.py` 报「标签里出现 N 个非 ASCII 字符」就是在提醒有新字。验收方法：`getComputedStyle` 之外，直接看 `document.fonts`——core 应 `loaded`、fill 应 `unloaded`，且 Network 里只出现 `fandol-core.*.woff2`。

## 5. 样式与美术方向

已声明的视觉语言是冷战构成主义海报：**平涂实色、硬边、直角、1px 发丝线、阴影只允许 `3px 3px 0` 的实色偏移（套印没对准），不做高斯模糊、不做金属/木纹渐变**，全站只新增一种颜色——红旗红 `--motion-accent`（浅色 `#a8271b`，深色 `#d2503a`）。`src/styles/homepage-motion.css` 头部与 `RadioPlayer.astro` 里都写了这套规则。

要遵守的两条工程约束：

- 主题令牌在**每个页面自己的 `:root`** 里定义（浅色块 + `data-theme='dark'` 块 + `prefers-color-scheme` 块三处要一起改）。
- 针对某个页面自有 class 的覆盖（例如 `@media (prefers-reduced-motion: reduce)` 里的 `.volume-panel`、`.chapter-item`）**必须写在该页的 `<style>` 内**。Astro 给 scoped 样式加了 `data-astro-cid-*` 属性，特异性高于同名全局选择器，写在 `homepage-motion.css` 里会静默输掉。

小字号文本对 `--gold`（`#8d7a5a`）在纸色上只有 3.66:1，不达 WCAG AA；红色在深色底上 4.33:1。所以 0.74rem 一档的文字请用 `--ink` / `--ink-soft`，红色只用于描边和实色偏移这类图形元素。

## 6. 部署

Cloudflare Pages 监听本仓库分支并自己执行 `npm run build`，输出目录 `dist`。

- **不要用 Direct Upload 只传 `dist/`**：那不含 `functions/`，`/api/auth`、`/api/discussions` 会整个消失。
- Pages 从 GitHub 构建，**只有已提交的文件会上线**。本地看到的东西和线上的东西不是一回事，提交前确认新文件真的进了 git（`functions/_lib/`、`public/_headers`、`src/utils/`、`src/styles/` 漏任何一个都会让线上或构建直接坏）。

### 需要配置的环境变量与绑定

| 名称 | 配在哪 | 用途 |
| --- | --- | --- |
| `AUTH_STORE` | KV namespace | 用户表、登录限流计数、会话吊销名单、会话密钥兜底 |
| `DISCUSSION_STORE` | KV namespace | 留言表与留言限流 |
| `SESSION_STORE` | KV namespace（可选） | 拆分上述用途；没绑时代码自动退回 `AUTH_STORE` |
| `AUTH_SECRET` | **Secret**（≥32 字符） | 会话 Cookie 的 HMAC 签名，也是限流假名桶的密钥 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | **Secret** | 种子管理员，只存在于环境变量，永不写入 KV |
| `PUBLIC_SITE_URL` | **构建环境变量**（不是 Secret） | RSS 的订阅地址；Secret 在构建期读不到 |
| `MUSIC_A` / `MUSIC_B` / `MUSIC_C` | KV namespace × 3（**三个都要绑**） | 电台的音频分片。名字必须逐字一致；少绑一个，落在它上面的曲目一律 503 |
| `CF_ZONE_ID` / `CF_PURGE_TOKEN` | Secret（可选） | 删贴后清 CDN；token 只授予 Zone.Cache Purge 一项权限 |

`AUTH_SECRET` 缺失时，签名密钥会随机生成一次并存进 KV 的 `session:secret`；两者都没有则退化为进程内临时密钥—— isolate 重启后所有会话失效，限流桶也各自独立计数。口令类变量必须是 Secret：普通环境变量在 Pages 控制台和 API 响应里是明文可见的。

绑定改完要**再部署一次**才生效，Pages 不会热更新 Functions 的配置。本地调 `/track/*` 用 `wrangler pages dev dist`，`.dev.vars` 里给三个本地 namespace 即可。

## 7. 安全模型（要点）

**输入清洗分四层**，各拦各的：`src/utils/sanitize.ts` 的 `escapeHtml()` 负责写进 HTML 前转义；`functions/_lib/security.js` 的 `sanitizeText()` 在读写 KV 时二次清洗（去标签、去控制字符与零宽字符、去 `javascript:` 等危险协议、限长）；`readJsonBody()` 只接受 JSON 内容类型，表单式跨站请求直接拒；`public/_headers` 兜底。

**CSP 是 header 型且不含 `'unsafe-inline'`、hash 或 nonce**（`script-src 'self'; style-src 'self'`）。静态站点发不出每次请求的 nonce，而 Astro 已把每页的脚本与样式打进 `/_astro`，所以没有需要放行的内联块。`tools/csp-guard.mjs` 在构建后扫一遍产物，一旦哪个页面重新出现内联样式/脚本就让构建失败——因为那在生产里是静默失效的。配套的是 `astro.config.mjs` 的 `inlineStylesheets: 'never'`。

**账号与会话**：PBKDF2-SHA256（默认 15 万次迭代 + 随机盐），KV 里不存明文；只接受哈希过的账号，早期遗留的明文记录即使密码正确也无法登录，下次写入会顺手清掉（所以换代码前请先删 `AUTH_STORE` 的 `users` 键）。Cookie 为 `HttpOnly; Secure; SameSite=Lax` 且带签名，`role` 无法靠手拼 cookie 伪造。每个会话有独立 `tokenId`，登出与顶号会把旧 token 写进吊销名单（TTL 等于其剩余寿命，上限 30 天），被盗用的 token 立刻失效。用户名不存在时同样执行一次派生，避免用响应耗时枚举账号。

**限流**：登录/注册按 IP + 用户名 15 分钟 8 次；每 IP 每小时最多注册 5 个；**每 IP 15 分钟最多 60 次密码派生**（轮换用户名会给每个名字新开一个桶，这条才是真正封顶 CPU 的，且检查发生在查库之前，节流期间存在与不存在的用户名返回同一个 429）。留言 60 秒窗口内匿名 3 条、登录 10 条。留言列表只保留最新 30 条，账号总数上限 200（KV 单键尺寸决定），满员时注册返回 503 而不是签发一个没存下来的会话。

**访客 IP**：限流桶的身份是 `HMAC(IP[+用户名], 会话密钥)` 前 16 位，KV 里只有 `rl:auth:<digest>` 这类假名键，不再有明文 IP，也不再暴露正在被爆破的用户名。留言、账号、会话都不存 IP。限流依赖 `CF-Connecting-IP`；当前域名直接解析到 Cloudflare 边缘所以可信，若以后前面挂了别的反代，这个头会变成代理出口 IP，全体访客塌进同一个桶（匿名留言集体 429），换解析方式必须复测。**不要在面板开启请求日志留存 / Logpush 导出**：把短期可见变成长期留存，与本站功能无关。

**审核能力**：`DELETE /api/discussions` 只接受已签名会话里 `role === 'admin'` 的身份（作者名一律从会话解析，不读请求体），删完由 `_lib/purge.js` 尽力清一次 CDN；purge 失败不改变删除结果，也不给管理员报错。

**已知历史问题**：早期版本把管理员账号口令硬编码在 `functions/api/auth.js` 里，而这个仓库是 public，凭据已进入公开的 git 历史（`git log -p` 可复原），必须视为已泄露——现在的口令只从 Secret 读取。

## 8. 电台与音频

音频**不进仓库**：GitHub 单文件上限 100 MiB，而且几百首一旦提交就永远留在 git 历史里，每次克隆和构建都得拖着它们。`public/music/` 因此整个目录进了 `.gitignore`（只有 `.gitkeep` 和 `README.md` 入库），但页面仍在构建期 `readdir` 它并把文件名烘进列表——副作用是本机往这里放音频会出现在 `localhost:4321` 的电台里，却因为没进 git 而不上线。这是「本地能播、线上没有」的唯一原因，和构建缓存无关。目录空着时 `readdir` 的报错被 `catch` 吞掉，列表退化为「载入磁带」，构建照常。

线上播放分三步，每一步只有一个文件负责：

```sh
py -3 tools/music_manifest.py F:\BilibiliCache\download --bili   # ① 生成 src/data/music.mjs
node tools/music_kv_put.mjs --stage F:\BilibiliCache\music-stage --dry-run
node tools/music_kv_put.mjs --stage F:\BilibiliCache\music-stage # ② 切片写进三个私有 KV
# ③ functions/track/[id].js 按 Range 把那几片拼回来，是电台唯一的取音出口
```

① 生成的是**已提交**的清单（794 首，含库内相对路径 `key`、字节数、12 位不透明 `id`）；② 上传的是文件本体（885 个 key，1.839 GiB）。`id` 是 `key` 的 sha1 前 12 位，所以**只改标题、作者、风格这类展示字段不会换 id，不用重传**——diff `music.mjs` 里的 `id/key/bytes` 就能确认这一点。反过来，从清单里剔掉一首也不会自动删掉它已经上传的分片：那些 key 留在 KV 里当孤儿（`/track/<id>` 从此不认它），要真空出地方得按 `key` 手动删。

为什么要绕 `/track/<id>` 这一圈，而不是把存储的公开地址直接塞进 `<audio>`：

1. `public/_headers` 里 CSP 钉了 `media-src 'self' blob:`，外链地址浏览器根本不会去取，同源路径才放得行。
2. 存储是私有的。访客只拿到 12 位 id，看不到里面的对象名，也拼不出别的键去捞没上节目单的东西。
3. 顺带把 `Range`/`206` 做对——没有断点续传的音频在手机上要么拖不动，要么整首先下完才响。

**后端是 KV 而不是 R2**：开 R2 要挂银行卡，KV 在账号已有的免费额度里。代价是 KV 没有 Range 读（一次 `get` 会把整个值拉回来），所以才按 `PART_SIZE` 切片存放，请求区间落在哪几片就只读哪几片；文件总长从清单的 `bytes` 拿，不需要 R2 那次 head 探测。4 MiB 这个数是额度算出来的：794 首里只有 57 首会被切开，平均一次请求读 1.11 片，最坏一次拖进度条拉回 4 MiB；切到 2 MiB 会把 key 数从 885 推到 1320，超出 KV 每天 1000 次写的免费额度，上传就得跨两天跑。

分流是 `shardOf(id)` = id 末位十六进制 `% 3`，纯函数、不查表。**改 `SHARDS` 或 `PART_SIZE` 等于全库重传**，这两处常量只应改一次。额度现状：每个 namespace 上限 1 GiB，实际 `MUSIC_A` 0.65 / `MUSIC_B` 0.64 / `MUSIC_C` 0.56 GiB（314 / 297 / 275 个 key）；全站每天 100k 次读。上传脚本断点续传（开跑前列一遍已有 key，已存在即跳过），中断后重跑同一条命令即可；单日写超 1000 会自动只写前 1000 个，第二天接着传。

B 站缓存目录用 `--bili` 模式：每个 `<avid>/<c_cid>/entry.json` 是一首，作者取 `owner_name`，时长取 `total_time_milli`，字节取该目录下最高音质的 `audio.m4s`。视频、封面、弹幕一律忽略，也不需要标签库（`mutagen` 只在松散文件模式用）。`audio.m4s` 是 fragmented MP4，浏览器直接可播，**不需要 ffmpeg 转码或 remux**。

曲名不是直接抄 `page_data.part` 就完事——那一格大多是上传时的文件名（`studio_video_1712345678901.mp4`、`lv_0_20240301120530`、`mmexport…`、`VID_20230815_113244.mp4`、`新项目 6 [B49F4E4]`、`P1`、`？`，或者一长串零宽字符）。`tidy_title()` 先剥掉扩展名、平台尾巴（`- YouTube`）、编码尾巴（`-x264 60fps`）、`副本 (2)`、画质方括号（`【Hi-Res 24bit/192kHz】`）与不可见字符；剩下没有一个真字母（各脚本各自的字母，`isalpha()` 对汉字是 False，所以自己列了码段）就判定成文件名，改用顶层视频标题，标题也画不出字就用 `未命名 · <BV号>`。改完还会二次撞名：同一稿件补 ` P<页号>`，跨稿件各自换成自己的视频标题。最后按新曲名重算一遍 `genre`（`build()` 里是按老名字猜的）。这一层只动展示字段，`key`/`id`/`bytes` 一个字都不改，**不用重传**；现在 794 首里 0 个曲名还是文件名、0 个重名。

**入选规则**：短于 30 秒、长于 1 小时的丢弃——缓存里的短片很少是想听的整曲，超长的通常是合并稿而不是单曲；真要收进的合并稿用 `--keep-long <key或标题子串>` 点名放行（可以重复给）。就是不想上电台的稿子写进代码里的 `DROP_KEYS`（按 `key` 前缀点名）——这张表故意不做成命令行参数，命令行下次重跑就忘了，那首歌会自己爬回来。同一首歌的不同版本全部留下，清单**永不查重**。**不要重命名缓存里的文件**：`key` 就是路径本身，改名会让那一首的 id 变掉、必须重传。

`genre`（节目单上的「风格」下拉）不是元数据，是 `classify_genre()` **猜**的：15 条按顺序命中的关键词规则、七百多个词，第一条赢，全落空就叫「其他」；带西里尔字母又一个词都没命中的算「红歌」——这批缓存里那是苏联系歌的标志。字段**分两趟用**：先拿曲名和视频标题（`title`/`album`）把整套规则跑完，一个都不中才换作者和盘架（`artist`/`side`）再跑一遍。这一趟非分不可——词边界把汉字与 ASCII 的接缝也算作边界，所以 `"mc"` 会在「夜空星MC」里命中，把那个 UP 主一整稿 47 首 WARNO（预先号令）游戏原声全标成「说唱」；同类的雷还有「出格字幕组」「最佳金曲」「东方没有胡桃」「高举红旗的白熊」。作者名只配当兜底（曲名里一个词都没有的 `sakanaction鱼韵乐队` 那种才靠它）。标签一律取短名，15 格：**游戏 134 / 术力口 130 / 其他 109 / 红歌 77 / 电音 76 / 流行 65 / 摇滚 58 / 鬼畜 38 / 番剧 33 / 翻唱 23 / 民族 14 / 伴奏 12 / 纯音 12 / 后朋·金属 10 / 古典 3**（数字随清单变，重跑生成器自己数；「说唱」现在是空的一格，下拉里不会出现）。ASCII 关键词按词边界匹配（否则纯子串会让 `deo` 命中 `video`、`live` 命中 `believe`），中文按子串。规则顺序很重要——越具体的越靠前（「伴奏」比「纯音乐」准，「初音ミク」比「日语」准），而 `punk` 这种会撞进「Daft Punk」的短词绝不单独用。宁可落进「其他」也不为了填满格子把一首塞错：目前 109/794（13.7%）在「其他」，这是这批缓存的真实构成，不是分类器坏了。`tests/track.test.mjs` 只守它的形状（每首都有标签、标签不超过 20 格、短到塞得进下拉框、「其他」不到四成），不守猜得对不对。

「风格」和「归类」两个下拉是**互相数数**的：每一格的每一项都按另一格（加检索词）筛过的结果统计，所以各项首数加起来永远等于「全部」那一行，也等于眼前的列表；已经选中的一项永远留在下拉里（哪怕别的筛选把它变成 0 首），不会被悄悄改掉。货架有 449 个，塞满下拉没人滚得动，所以「归类」只列成排的（≥2 首）前 40 个，末尾补一行 disabled 的「另有 N 项 · M 首（用检索找）」把账填平——落单的那位用检索框找，检索也匹配货架名。两格只在**清单为空**（读取失败、或检索一个都不剩）时才置灰；「这个归类下恰好只有一种风格」不是锁的理由，置灰的控制件看起来像坏了。

`/music/tracks.json` 的响应头是 `max-age=0, must-revalidate` + `Cross-Origin-Resource-Policy: same-origin`：电台只在第一次打开货舱时 fetch 一次，而改标题、改风格、剔歌都是这件常做的事，缓存一天会让访客拿着旧清单来报「分类不对」（部署后第一次开抽屉还要按 ETag 回源，代价是一次 304）。

**退出计划**：仓库只有清单，音频在私有 namespace。要搬家就把 KV 里 `${key}/${part}` 的每个键按 `part` 顺序拼回文件——键表完全由 `src/data/music.mjs` 加上 `PART_SIZE` / `shardOf()` / `partKey()` 三个导出算出来，`node tools/music_kv_put.mjs --dry-run` 打印的就是这份计划（每桶几个 key、占多少 GiB，不读不写凭证也能跑）。换任何私有桶 + 同源路由的后端，只改 `functions/track/[id].js` 一个文件——前端、CSP、清单里的 id 都不用动。

## 9. 工作室 `/studio/`

一个零依赖的浏览器 DAW（步进网格 + 钢琴卷帘 + 采样 + WAV 导出），页面上标的是「Sawer DAW 测试版本」。**没有前端框架、没有音频库**，`src/utils/studio/` 九个原生 ES module 各管一件事，`src/pages/studio.astro` 只负责骨架和 `<style>` 里的美术覆盖：

| 模块 | 职责 | 为什么单独切出来 |
| --- | --- | --- |
| `types.ts` | 数据模型与常量（`STEPS=16`、`PPQ=4`、`RESOLUTION`、吸附档位表） | UI 层、发声层、持久化层共用同一份「什么算一个项目」 |
| `engine.ts` | 发声：振荡器 + 噪声缓冲现场合成鼓与合成器 | 实时播放和离线导出共用 `playNote()`，两边听到的才是同一个东西 |
| `scheduler.ts` | lookahead 排程：`setTimeout` 只管醒来，绝对定时一律用 `AudioContext.currentTime` | 定时器抖动几十毫秒节奏就抖；按**整步**排而不是整首排，播放中改网格/音量/采样，播放头走到下一步立刻生效 |
| `notes.ts` | 音符增删改（吸附、跨小节、同音高重叠） | 网格与卷帘共用，否则边界条件各写一套、各错一处 |
| `piano-roll.ts` | 卷帘 | 行高与列宽读 CSS 变量（`--roll-row-h`、`--roll-tick-w`），JS 不写死，小屏要放大触控目标 |
| `samples.ts` | 采样导入 + IndexedDB 持久化（单个 12 MiB、最多 48 个） | 采样只来自用户自己的文件；`AudioBuffer` 活在内存，磁盘上存原始字节 |
| `wav-export.ts` | `OfflineAudioContext` 离线渲染成 RIFF/PCM | 精确到采样、不受主线程卡顿影响，也不要 `getUserMedia` 权限 |
| `store.ts` | localStorage 存档 | 存档**按外部输入处理**：逐条校验 + 钳制，否则一个 `tempo:"abc"` 就让排程器算出 `NaN`、播放头卡死 |
| `studio-app.ts` | UI 装配 | — |

要改这个页面得知道的三条：

- **参数一律摆在明面上**：力度是网格上方那个 `<select>`（先选力度再点格子，点格子只开关音符），卷帘的细分靠可见的「自动对齐」下拉框。交互是「单击行名试听、双击行名进卷帘」——注意别在单击的处理里重建网格：重建会把行名节点换掉，双击的第二下打在已经离开的节点上，`dblclick` 就发不出来了（`studio-app.ts` 里的 `selectTrack()` 专门只改高亮）。
- **CSP 不含 `'unsafe-inline'`，也没有 `worker-src`**。所以几何只能用 CSSOM 单属性赋值（`el.style.left = '…'`）——浏览器只拦「解析 style 字符串」，不拦逐条赋值；WAV 的交错编码留在主线程。这两种写法线上已有三处在跑（阅读进度条、收音机指针、卷帘音符块）。
- **手机是主战场**：样式按 320 px 起排，验收靠同源 iframe 固定宽度实测计算样式，不靠截图猜。

`src/utils/midi.ts` 属于电台那一侧：`<audio>` 解不了 `.mid`，现成播放库要么带几十 MB 的 SoundFont 要么整包拖进 Tone.js，所以只解析 SMF 的 note on/off、program change 和 tempo meta，用振荡器按 GM 音色族近似发声；输入是用户随手选的文件，属于系统边界，解析失败一律返回 `null`。

## 10. 订阅与可安装

- `/rss.xml`：零依赖手写 RSS 2.0，`Cache-Control: public, max-age=1800`。订阅地址取 `PUBLIC_SITE_URL`；`CF_PAGES_URL` / `DEPLOY_URL` 只是兜底，那是每次部署都换的 `*.pages.dev`，绝不能当订阅地址发出去。
- `manifest.webmanifest` + `public/icons/*`：图标不是设计稿，是被安装程序硬约束的资产（Chrome 要 192/512，Apple 要 180×180 不透明，Android 会裁圆/方/squircle，maskable 版必须满幅底色并把图形压进中央 80%）。改配色或轮廓后重跑 `npm run icons`。
- `public/.well-known/security.txt`：漏洞联系方式。

## 11. 有意为之的取舍

- **状态全在 KV 的三个键族里**（`users`、`comments`、`rl:*` / `revoked:*` / `session:secret`），整表读写 = 每次注册/留言都是「读-改-写 + 条件写（CAS）」。这个量级下比 D1 更省、故障面更小；一旦需要分页、按用户查询或审计，应该换 D1，而不是继续加大 KV 值。
- **限流与派生计数 fail-open**：KV 读失败或命名空间没绑时放行，把可用性排在容量问题之前；代价是没绑 `AUTH_STORE` 时注册限速完全失效，因此接口会把「未配置存储」显式报给前端。
- **`role: 'admin'` 现在只授予删留言**，没有别的特权。
- **没有改密 / 找回密码流程**：忘记密码等于账号永久不可用。任何 reset 令牌都是一处新的可被滥用的状态机，暂时不做。
- 留言数据全公开，所以 `GET /api/discussions` 值得缓存（`max-age=20, stale-while-revalidate=60`，新留言最多晚 20 秒出现）；`POST`、`DELETE` 与 `/api/auth` 一律 `no-store`。
- 前端只暴露 `{name, verified}`，评论记录只有 `id/name/message/createdAt/verified`。

## 12. 行尾：别按常识推断

`core.autocrlf=true` 且**没有 `.gitattributes`**，而 HEAD 里的文本 blob **就是 CRLF**——autocrlf 的 safe-crlf 规则不会再去清洗已含 CRLF 的文件，所以提交保持原样。风险方向是反的：**谁把某个文件整文件按 LF 重存一遍，diff 就会显示整文件改动**，看起来像"别人把我的改动回退了"。

怀疑时的判据（两个数字一样 = 没有行尾噪声，差很多 = 行尾问题）：

```sh
git diff --stat
git diff --ignore-cr-at-eol --stat
```

加 `* text=auto` 的 `.gitattributes` 要单独挑一个没人改文件的窗口做，别在任务中途加——它会重写所有文件的 diff。

## 13. 提交流程

1. `git status` 逐条看清，**不要 `git add -A` 一把梭**。
2. 确认 `.dev.vars`（里面有 `AUTH_SECRET` / `ADMIN_PASSWORD`）、`.env`、`.wrangler/`、`dist/`、`public/music/` 下的音频、`*.ttf` 都不在待提交列表里。
3. 改过 `functions/**`、`src/pages/**` 或组件前重新读一遍——可能有并行的编辑已经落在文件里。
4. `npm run verify` —— build + CSP 守卫 + 105 条后端安全测试 + 77 条电台路由测试，少一条就别推。
5. 推 `main`（commit 不会上线，**push 才触发构建**；新加/改动的 KV 绑定要在下一次部署后才生效）。
6. 上线后自己硬刷新一章：只应下载 `fandol-core.*.woff2`；`/api/discussions` 要带 `max-age=20` 与 `cf-cache-status`；`/api/auth` 要 `no-store`；CSP 头要在；电台的点歌应当真的出声音，`/track/<id>` 回 `206` 而不是 `503`（503 通常是某个 `MUSIC_*` 没绑）。

## 14. 许可

- 字体：仿宋 FandolFang R，Fandol 团队（Clerk Ma、Jie Su），GNU GPL-2.0+ 加字体嵌入例外，说明见 `public/fonts/FANDOL-LICENCE.txt`、全文 `public/fonts/GPL-2.0.txt`，上游是 http://www.ctan.org/tex-archive/fonts/fandol 。仓库里的 `fandol-*.woff2` 是它的子集（改作），同样按这份许可证分发。
- 小说正文：原创作品，**未在仓库内声明授权**，默认保留所有权利。
- 代码与其余素材：仓库根目录**没有 `LICENSE` 文件**，因此同样没有授予任何人再分发的权利。要给代码定一份许可（MIT / Apache-2.0 之类）请单独决定并补文件，别默认「开源仓库 = 代码可随便用」。
- 节目单里的曲目来自各 UP 主自己的投稿，仓库只存清单与私有分片，不提供二次下载；`src/data/music.mjs` 里的标题与作者名是事实性元数据。
- 漏洞报告见 `public/.well-known/security.txt`。
