// 电台节目单：/music/tracks.json
//
// 为什么单独一个文件，而不是把清单直接写进页面：收音机出现在主页和 40 多个章节页
// 上，700 条曲目内联进每页 HTML 就是几十 KB × 44 的白下载。这里让电台在真的打开
// 歌单时才 fetch 一次，同源、走 CSP 里已有的 connect-src 'self'。
//
// 只输出电台要显示的字段。key（存储里的相对路径）留在 src/data/music.mjs 里，只有
// functions/track/[id].js 读它——浏览器拿不到，也就拼不出 KV 里的键。
import { musicTracks } from '../../data/music.mjs';

function publicTrack(track) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    side: track.side,
    duration: track.duration,
    // 电台靠它区分磁带和 MIDI：/track/<id> 这种地址没有扩展名可看。
    format: track.format,
  };
}

export async function GET() {
  const tracks = musicTracks.map(publicTrack);
  return new Response(JSON.stringify({ tracks }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
