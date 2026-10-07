# 《吊灯》小说站说明

这是一个基于 Astro 的轻小说阅读站，英文名沿用父文件夹名称：

- English: Chandelier In the Midnight with an Idoit and a Cup
- Chinese: 《吊灯》

项目的核心结构是：

```text
Novel-blog/
├── README.md
├── package.json
├── functions/                 # Cloudflare Pages Functions
│   ├── _lib/security.js       # KV 层清洗、密码哈希、会话签名、限流
│   └── api/
│       ├── auth.js
│       └── discussions.js
├── public/
│   ├── _headers               # CSP 与安全响应头
│   └── music/
├── src/
│   ├── content.config.ts
│   ├── content/
│   │   └── novels/
│   │       ├── 第一卷/
│   │       ├── 第二卷/
│   │       └── ...
│   ├── utils/
│   │   ├── sanitize.ts        # 输出到 HTML 前的转义与清洗
│   │   ├── theme.ts           # 深色模式切换
│   │   └── tesseract.ts       # 超立方体动画（主页与 404 页共用）
│   └── pages/
│       ├── index.astro
│       ├── 404.astro          # 自定义 404 页
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
- 404 页样式在 `src/pages/404.astro`，动画逻辑在 `src/utils/tesseract.ts`
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

部署走 Git：Cloudflare Pages 监听本仓库分支，自己执行 `npm run build`，输出目录填 `dist`。**不要用 Direct Upload 只传 `dist`**——那样不含 `functions/`，`/api/auth` 和 `/api/discussions` 会整个消失。

音乐文件放到：

```text
public/music/
```

支持的音频格式包括 MIDI、MP3、WAV、OGG、FLAC 等。部署后，页面会自动扫描这些静态文件并在左侧音乐播放器中列出可选项。

### 部署链路：上线前必须核对

本地文件和线上内容不是一回事——Pages 从 GitHub 构建，只有**已提交**的文件会上线。核查结论（2026-10-07）：

- `git ls-files` 显示以下文件仍是未跟踪状态，因此线上完全没有它们：
  - `functions/_lib/`：`api/auth.js`、`api/discussions.js` 都 `import` 它。若只把改好的端点提交而漏掉 `_lib`，Functions 构建会直接失败
  - `public/_headers`：CSP、HSTS、`X-Frame-Options`、`Permissions-Policy` 等全部安全头。**实测线上响应里一条都没有**
  - `src/utils/`（`sanitize.ts`、`theme.ts`、`tesseract.ts`）、`src/pages/404.astro`、`tests/`
- 线上跑的是提交 `655d4d0` 那版旧代码，实测漏洞：
  - 会话 Cookie 是**未签名的 JSON**，`GET /api/auth` 会原样回显 `role`：手工拼一个 cookie 就能自称管理员
  - 旧代码里硬编码了管理员账号与口令，而仓库 `Aralook233/A-Chandelier-In-the-Midnight` 是 **public**，凭据已进入公开的 git 历史（`git log -p -- functions/api/auth.js` 可复原），必须视为已泄露：改密码、只通过 Pages Secret 配置 `ADMIN_USERNAME`/`ADMIN_PASSWORD`
  - 注册账号以明文存进 KV，`/api/discussions` 的 `name` 字段完全由请求体决定且渲染时未转义
- 因此切换前：先删掉 `AUTH_STORE` 的 `users` 键（旧明文账号无法登录，见下节），再一次性提交 `_lib/`、`public/_headers`、`src/utils/`、`src/pages/`、`tests/`
- Cloudflare Pages 项目侧要确认：Production 与 **Preview** 是否绑定同一个 KV（预览部署的 `*.pages.dev` 链接对任何人可访问，且会写生产数据）；`SESSION_STORE` 若没绑定，登出吊销会退化为只清 Cookie
- 线上所有响应带 `Access-Control-Allow-Origin: *`，而仓库里没有任何地方配置它——来源在 Cloudflare 控制台（Transform Rules / Pages 自定义头）或 DNSHE 侧，需要去面板确认并去掉
- 线上 KV 的留言列表里还留着两条攻击载荷（`<script>…</script>`、`<img src=x onerror=…>`），确认无用后删除

### 域名与 DNSSEC 的实际链路

`loop-Chandelier.de5.net` 的权威名字服务器是 `a.ns.dnshe.org` / `b.ns.dnshe.org`，也就是 **DNSHE 的 `de5.net` 公共区域**，不是 Cloudflare 托管的 zone：

- Cloudflare 只在 `de5.net` 之内签发一个主机名 / 提供 Pages 边缘，DNSSEC 必须由**区域的签名者**（`de5.net` 一侧）并把 DS 提交到 `.net` 才生效。Cloudflare 面板里给自己的 zone 开 DNSSEC，对一个 `*.de5.net` 主机名不起作用
- 边缘证书由 Google Trust Services 签发（`CN=loop-chandelier.de5.net`），信任链完全依赖 CA 的签发校验；`de5.net` 未设 CAA 限制，且子域由第三方免费分发，存在**子域被回收/被他人申领**与越权签发的风险
- 想让 DNSSEC 真正成立，需要用自己持有的域名（在 Cloudflare 建 zone、开启 DNSSEC、把 DS 提交到注册商），而不是 DNSHE 的免费后缀
- 本次网络无法查询 DS/CAA（DoH 出口被拦），上述记录以 `nslookup` 实测的 NS 为准；DNSSEC 状态请在 https://dnssec-analyzer.verisignlabs.com 输入你的主机名复核

## 3. 安全与运行配置

### 输入转义与清洗

- 渲染层：`src/utils/sanitize.ts` 提供 `escapeHtml()`，留言区所有插值在写入 HTML 前统一转义
- 存储层：`functions/_lib/security.js` 的 `sanitizeText()` 在写入 / 读取 KV 时二次清洗（去标签、去控制字符、去 `javascript:` 等危险协议、限长）
- 接口层：`readJsonBody()` 只接受 `application/json`（或 `+json`）内容类型，表单式跨站请求直接拒绝
- 传输层：`public/_headers` 部署 CSP（`script-src 'self'`，无 `unsafe-inline`）与其他安全响应头

### Cloudflare Pages 需要配置的环境变量 / 绑定

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `DISCUSSION_STORE` | KV namespace | 留言存储 + 留言限流计数 |
| `AUTH_STORE` | KV namespace | 用户存储 + 登录限流计数 + 会话吊销名单 |
| `AUTH_SECRET` | Secret（≥32 字符） | 会话 Cookie 的 HMAC 签名密钥 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Secret（≥12 位） | 初始管理员账号，仅用于首次登录 |

生成密钥示例：`openssl rand -base64 48`。缺少 `AUTH_SECRET` 时，签名密钥随机生成一次并保存在 KV 的 `session:secret`；两者都没有时退化为进程内临时密钥，实例重启后所有会话失效。

`ADMIN_PASSWORD` 必须配成 Secret：它是明文比对的环境变量，放在普通环境变量里会在 Pages 控制台和 API 响应中直接可见。

### 账号相关行为

- 密码以 PBKDF2-SHA256（15 万次迭代 + 随机盐）存储，不再保存明文
- 只接受哈希账号：KV 里遗留的明文记录（早期版本写入的）**无法登录**，即使密码正确；下一次注册或写入会把它们从 `users` 键中清除，明文不会继续驻留存储
- 因此部署新代码前请先删除 `AUTH_STORE` 的 `users` 键：旧注册用户需要重新注册，这是有意为之——那些密码此前一直以明文躺在 KV 里，等同于已泄露
- 管理员种子账号只在环境变量中，永远不会被写进 KV
- 会话 Cookie 为 `HttpOnly; Secure; SameSite=Lax`，且带签名，无法伪造 `role`
- 每个会话带独立 `tokenId`：登出、以及重新登录时的旧会话会被写入 `revoked:<tokenId>` 黑名单（TTL 等于该会话原本的剩余寿命），因此**登出后被盗用的 token 立即失效**，不再只依赖 Cookie 过期
- 顶栏登录后会变为「退出 · 昵称」，点击即触发上述服务端吊销
- 登录失败统一返回同一提示，且用户名不存在时同样执行一次 PBKDF2 派生，避免用响应耗时枚举账号
- 注册密码至少 8 位；同一 IP + 用户名 15 分钟内最多 8 次尝试；同一 IP 每小时最多注册 5 个账号；**同一 IP 15 分钟内最多 60 次密码派生**（轮换用户名会为每个名字各开一个新桶，这条才是真正封顶 CPU 的）；账号总数受 KV 单键上限约束（200 个），满员时注册返回 503 而不会签发一个未被存储的会话
- 留言限流：匿名 1 分钟内 3 条，登录用户 1 分钟内 10 条；留言列表最多保留最新 30 条
- 用户列表的并发写入使用 KV 条件写（compare-and-swap）保护，注册冲突会重试而不是互相覆盖

### 访客 IP 与日志留存

- 限流桶的身份标识是 `HMAC(IP[+用户名], 会话密钥)` 的前 16 位（`functions/_lib/security.js` 的 `bucketIdentity`）。KV 里只出现 `rl:auth:<digest>` 这类假名键，**不再有明文 IP，也不再暴露"谁正在被爆破"的用户名**；分桶粒度与限流行为不变（测试第 17 节覆盖）
- 前提是密钥稳定：配好 `AUTH_SECRET`（或让 `SESSION_STORE`/`AUTH_STORE` 里的 `session:secret` 生效）。两者都缺省时签名密钥是进程内临时的，假名会随 isolate 变化，限流桶也就各自独立计数
- 不要在 Cloudflare 面板开启请求日志留存 / Logpush 导出。访客 IP 在边缘必然可见（`CF-Connecting-IP`，控制台 Security → Events、Analytics & Logs 都能看到），但那是 Cloudflare 侧的可见性；把日志持久化或导出到自己的存储会把短期可见变成长期留存，与本站功能无关，明确不做
- 留言、账号、会话中都不存储访客 IP：`/api/discussions` 的响应只回 `{name, verified}`，评论记录只有 `id/name/message/createdAt/verified`
- 限流依赖 `CF-Connecting-IP`。当前 `loop-Chandelier.de5.net` 直接解析到 Cloudflare 边缘，所以该头可信；如果以后改成由 DNSHE 之类做前置反向代理，这个头会变成代理的出口 IP，所有访客会塌进同一个限流桶（匿名留言会集体 429）。换解析方式后必须复测
- 提醒：访客侧唯一能改变自己所暴露 IP 的办法是走代理/VPN/Tor，浏览器内部设置（清 Cookie、无痕、改 UA）都换不掉 IP

### 架构取舍（有意为之，不是遗漏）

- **无数据库，全部状态在 KV 三个键族里**：`users`（整表一个值）、`comments`（整表一个值）、`rl:*` / `revoked:*` / `session:secret`。整表读写意味着每次注册/留言都是「读-改-写 + 条件写（CAS）」，规模上限是 200 账号 / 30 条留言。这个量级下比 D1 更省、更少故障面；要长出「分页、按用户查询、审计」这类需求时应当换 D1，而不是继续加大 KV 值
- **会话是无状态签名的**（HMAC + `tokenId` 吊销名单），所以「登出/改密后立刻失效」靠的是 KV 里一条 TTL 记录，而不是服务端会话表
- **限流/派生计数 fail-open**：KV 读失败或命名空间没绑时放行请求。理由是把可用性放在容量问题之前——代价是没绑 `AUTH_STORE` 时注册限速完全失效，因此 `warningFor` 会把「未配置存储」显式报给前端
- **`clientIdentity` 在无 `CF-Connecting-IP` 时退到 `X-Forwarded-For` 首跳**：本地 wrangler 需要它，但任何非 Cloudflare 边缘的前置都能伪造这个头（见上节）
- **公开读取可缓存、写入与身份查询不缓存**：`GET /api/discussions` → `public, max-age=20, stale-while-revalidate=60`；`POST` 与 `/api/auth` 一律 `no-store`。这是留言数据全部公开这一事实换来的优化
- **注册/登录的派生开销受每 IP 预算封顶**，且该检查在查库之前，节流期间的响应码对存在与不存在的用户名完全一致（429），不会把状态码变成枚举Oracle

### 待你决定的架构缺口（我没有擅自补）

- `role: 'admin'` 目前**不授予任何能力**：种子管理员和普通成员能做的事完全相同。要么把它接上（留言删除/审核端点），要么删掉这个字段，别留一个「看起来有权限」的假象
- **没有删除/审核留言的服务端接口**：出现刷屏或不当内容时只能手改 KV。补一个就要补 CSRF、权限校验与吊销语义，属于新功能而非修复
- **没有改密/找回密码流程**：忘记密码=账号永久不可用，需要你在面板侧处理。加任何 reset 令牌的表面都是一处新的可被滥用的状态机
- **Preview 部署与生产共用 KV** 的风险仍未验证（见「部署链路」节），这需要在 Pages 项目设置里确认，不是代码能解决的

`package.json` 通过 `overrides` 将 `http-cache-semantics` 锁定到 `^4.3.0`，用于修掉 astro 传递依赖里的高危缓存漏洞（GHSA-ch52-4w7c-c8xp）。升级 astro 后请用 `npm audit` 确认该 override 是否仍需要。

### 本地调试

`start.bat` 只监听 `127.0.0.1`。请勿改回 `--host 0.0.0.0`：那会把带源码与错误栈的 dev server 暴露到局域网。

### 深色模式

- 顶栏「深色 / 浅色」按钮切换，选择保存在 `localStorage`
- 未手动切换时跟随系统 `prefers-color-scheme`
- 主题变量集中在各页面的 `:root` 令牌中，新增颜色请走令牌而不是写死色值

### 手机端与平板端适配

- 三个页面都使用 `width=device-width, initial-scale=1.0, viewport-fit=cover`，并用 `env(safe-area-inset-*)` 处理刘海屏
- 断点约定：`1100 / 1024`（平板横屏，收窄侧栏）、`900 / 1040`（平板竖屏，改为单列）、`640 / 560 / 420`（手机）
- 单列时主页侧栏限高 `52vh` 并内部滚动，阅读页把正文排在目录之前，避免小屏先看到长列表
- 手机端首页动画区由正圆改为圆角矩形（`overflow: hidden` 保留裁切），「当前卷目」卡片固定在圆内底部
- 输入框字号统一 16px，避免 iOS 聚焦时自动放大页面；触控目标不小于 44px

### 自定义 404 页

- `src/pages/404.astro` 会构建成 `dist/404.html`，Cloudflare Pages 对未匹配路由自动返回该文件
- 复用主页的超立方体动画（`src/utils/tesseract.ts`），文案为「你怎么到这里来了？」
- 动画脚本已抽成共享模块，`index.astro` 与 `404.astro` 各自 `mountTesseract(canvas)`
- 页面同样走 CSS 令牌，支持深色模式，并且不含内联脚本 / 内联样式，符合 CSP

### 阅读进度条

- 位于章节页视口顶部，3px 高的固定条，颜色由 `--gold` / `--ink-soft` 令牌驱动
- 逻辑在 `src/pages/Novels/[...slug].astro` 的脚本里：`scroll` 监听 + `requestAnimationFrame` 节流，写入 `transform: scaleX()`
- 同时更新 `aria-valuenow`，读屏可获取百分比；`prefers-reduced-motion` 下关闭过渡

## 4. 注意事项

- 不要把无关的 `.md` 文件放进 `src/content/novels/` 目录
- 例如 `test.md`、临时草稿、未命名的文件都可能被误识别
- 章节名必须符合 `第XX章.md` 这种格式
- 若内容不规范，Astro 会在构建时报 `InvalidContentEntryDataError`
- `astro dev` 不会加载 `functions/` 目录，本地调试接口请用 `wrangler pages dev dist`

## 5. 如果你想继续更新

最重要的原则只有一句：

> 只在 `src/content/novels/` 里放正式章节，页面会自动读取，不用手动维护目录列表。
