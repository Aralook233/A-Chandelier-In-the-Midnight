# 这里不放音频

音频文件不进仓库，也不放这个目录：GitHub 单文件上限 100 MiB，而且几百首一旦提交就永远
留在 git 历史里，每次克隆和构建都要拖着它们。

真正的音轨放在私有的 Cloudflare Workers KV 里（三个 namespace，每首按 4 MiB 切成片），
仓库只保留一张节目单：

```
py -3 tools/music_manifest.py <音频文件夹>   # 生成 src/data/music.mjs
```

页面上的流程是：

1. 电台打开「节目单」时读 `/music/tracks.json`（由 `src/pages/music/tracks.json.js` 在构建时
   生成，只有 id、曲名、作者、盘架、时长）。
2. 点某一行时取 `/track/<id>`（`functions/track/[id].js` 从 KV 读那几片拼成请求的区间，
   照样支持 Range/206 断点）。存储里的 key 从来不给浏览器。

所以这个目录只剩下「`/music/` 这个前缀」这件事本身。要放本地文件直接试音，用收音机上的
「接入本机节目」，那是读你机器上的文件，不经过服务器。
