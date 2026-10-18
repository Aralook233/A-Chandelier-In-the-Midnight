"""Build the committed track list for the radio, from a folder of audio files.

The audio never enters git: the collection lives in a private Cloudflare Workers KV
vault (three namespaces, every track stored as 4 MiB slices), and this tool only
reads their tags locally to write src/data/music.mjs, which is what the site ships.
Each entry keeps both the stored relative path (the path relative to the folder you
point at) and an opaque ASCII id, so /track/<id> URLs never have to carry a Chinese
filename. The audio itself is pushed to KV by tools/music_kv_put.mjs.

    py -3 tools/music_manifest.py D:\\Music\\Chandelier
    py -3 tools/music_manifest.py F:\\BilibiliCache\\download --bili

--bili reads a B 站缓存 folder instead of loose audio files: every
`<avid>/<c_cid>/entry.json` is one track, its title comes from `page_data.part`
(the P name), its author from `owner_name`, its length from `total_time_milli`, and
the bytes come from the highest quality `audio.m4s` under it. Video, cover and
danmaku files are ignored, and no tag reader is needed, so mutagen stays optional.

Bilibili defaults match how the cache is actually filled: tracks under 30 seconds
and over an hour are skipped, since a cached clip is rarely a song you want on the
radio and an over-long one is a merge rather than a track. A real merge is kept by
naming it with --keep-long. Same song, different versions all stay in — the list
never dedupes.

The output is an ES module, not JSON, on purpose: Astro's Vite build, Cloudflare's
esbuild bundle for Pages Functions, and `node tests/...` all import it as-is, while
a .json would need import attributes that only some of those three accept.

Output is sorted and carries no timestamp, so re-running it only shows real changes.
After it reports new characters, rebuild the core font face (tools/font_faces.py) or
those titles will pull the 1.4 MB fill face at runtime.
"""

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

try:
    from mutagen import File as MutagenFile
except ImportError:  # only the loose-file mode needs tag reading
    MutagenFile = None

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "src" / "data" / "music.mjs"
SUFFIXES = {".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".m4b", ".aac",
            ".wav", ".aif", ".aiff", ".wma", ".ape", ".mp4", ".m4v", ".mka", ".m4s"}
ID_LENGTH = 12
BILI_AUDIO = "audio.m4s"
BILI_MIN_SECONDS = 30.0
BILI_MAX_MINUTES = 60.0
# easy=True flattens ID3 / MP4 / Vorbis / APE tag names onto one shared vocabulary.
TITLE_KEYS = ("title", "_title")
ARTIST_KEYS = ("artist", "albumartist")
ALBUM_KEYS = ("album",)
YEAR_KEYS = ("date", "originaldate", "year")
TRACK_KEYS = ("track", "tracknumber")


def tag_text(tags, keys):
    for key in keys:
        if not tags or key not in tags:
            continue
        value = tags[key]
        if isinstance(value, (list, tuple)):
            value = ", ".join(str(item) for item in value if item)
        text = str(value).strip()
        if text:
            return text
    return ""


def tag_number(tags, keys):
    for key in keys:
        text = tag_text(tags, (key,))
        head = text.split("/")[0].strip()
        if head.isdigit():
            return int(head)
    return 0


def build(path, folder, title, artist, album, year, number, duration, kind, side=None):
    rel = path.relative_to(folder).as_posix()
    top = rel.split("/", 1)[0] if "/" in rel else ""
    return {
        "id": hashlib.sha1(rel.encode("utf-8")).hexdigest()[:ID_LENGTH],
        "key": rel,
        "title": title or path.stem,
        "artist": artist,
        "album": album,
        "year": year or None,
        "track": number or None,
        "side": side or top or album or "未分类",
        "duration": duration,
        "bytes": path.stat().st_size,
        "format": str(kind).lower(),
    }


def describe(path, folder):
    rel = path.relative_to(folder).as_posix()
    note = None
    try:
        audio = MutagenFile(path, easy=True)
    except Exception as error:
        audio = None
        note = f"{rel}: 元数据读不出（{type(error).__name__}）"
    if audio is None:
        # A file we can only half-read still has to be listed, or the radio quietly
        # loses a song the bucket already holds.
        degraded = build(path, folder, "", "", "", 0, 0, 0, path.suffix[1:])
        return degraded, [f"{note or rel + ': 无法识别格式'}：按文件名入表，时长与标签留空"]

    tags = audio.tags or {}
    duration = round(float(audio.info.length), 2) if audio.info and audio.info.length else 0

    titled = tag_text(tags, TITLE_KEYS)
    track = build(
        path, folder,
        titled,
        tag_text(tags, ARTIST_KEYS),
        tag_text(tags, ALBUM_KEYS),
        tag_number(tags, YEAR_KEYS),
        tag_number(tags, TRACK_KEYS),
        duration,
        path.suffix[1:],
    )
    notes = []
    if not titled:
        notes.append(f"{rel}: 没有标题标签，用文件名代替")
    if not track["artist"]:
        notes.append(f"{rel}: 没有歌手/作者标签")
    if not duration:
        notes.append(f"{rel}: 读不到时长，列表里会显示为未知")
    return track, notes


def bili_audio_dir(part_dir):
    """A cached part keeps each clarity in `<清晰度>/audio.m4s`; the biggest code is the best copy."""
    copies = []
    for child in part_dir.iterdir():
        audio = child / BILI_AUDIO
        if child.is_dir() and audio.is_file():
            copies.append((int(child.name) if child.name.isdigit() else -1, audio))
    return max(copies)[1] if copies else None


def describe_bili(entry_path, folder):
    """One entry.json is one 分 P is one track — the sidecar already has every tag."""
    try:
        data = json.loads(entry_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return None, [f"{entry_path.parent.name}: 读不出 entry.json（{type(error).__name__}）"]

    audio = bili_audio_dir(entry_path.parent)
    if audio is None:
        return None, [f"{entry_path.parent.name}: 没有 {BILI_AUDIO}，这一 P 只能放过"]

    page = data.get("page_data") or {}
    album = str(data.get("title") or "").strip()
    artist = str(data.get("owner_name") or "").strip()
    title = str(page.get("part") or "").strip()
    number = page.get("page") if isinstance(page.get("page"), int) else None
    try:
        duration = round(float(data.get("total_time_milli") or 0) / 1000, 2)
    except (TypeError, ValueError):
        duration = 0.0

    track = build(audio, folder, title or album, artist, album, 0, number, duration, "m4s",
                  side=artist or album)
    notes = []
    if not title:
        notes.append(f"{track['key']}: entry.json 没有分 P 标题，用视频标题代替")
    if not duration:
        notes.append(f"{track['key']}: entry.json 没有时长")
    if not data.get("is_completed"):
        notes.append(f"{track['key']}: 缓存没标记完成，仍然入表")
    return track, notes


def stage_audio(tracks, folder, stage_dir):
    """Mirror just the audio into a staging tree, so an uploader sees the same keys.

    Hard links first: 800 files are minutes to make and cost no second copy of the
    bytes. Only files that are missing or that refuse a link (other volume, other
    filesystem) get copied.
    """
    made = 0
    for track in tracks:
        target = stage_dir / track["key"]
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        source = folder / track["key"]
        try:
            target.hardlink_to(source)
        except OSError:
            shutil.copy2(source, target)
        made += 1
    return made


def visible_chars(tracks):
    fields = ("title", "artist", "album", "side")
    text = "".join(str(track[field]) for track in tracks for field in fields if track[field])
    return {c for c in text if ord(c) > 0x7F and not ("\ud800" <= c <= "\udfff")}


def render(tracks):
    """The shipped manifest: one entry per line, so a re-run diffs as real changes only."""
    header = (
        "// 节目单：生成物，别手改，也别把手改当成修复——重跑工具会整片覆盖。\n"
        "//     py -3 tools/music_manifest.py <B 站缓存目录> --bili\n"
        "// 音频本体不在仓库里，在私有的 Cloudflare KV（三个 namespace，每首按 4 MiB 切片）。\n"
        "// key 是存储里的相对路径，只给 functions/track 用；页面拿到的是下面的 id，\n"
        "// 见 src/pages/music/tracks.json.js。\n"
    )
    lines = [json.dumps(track, ensure_ascii=False) for track in tracks]
    body = "export const musicTracks = [\n" + "".join(f"  {line},\n" for line in lines) + "];\n"
    return header + "\n" + body


def collect(folder, bili):
    if bili:
        tracks, warnings = [], []
        for entry in sorted(folder.glob("*/*/entry.json")):
            track, notes = describe_bili(entry, folder)
            warnings.extend(notes)
            if track:
                tracks.append(track)
        if not tracks:
            raise SystemExit(f"{folder} 下没有 <avid>/<c_cid>/entry.json + audio.m4s，确认这是 B 站缓存目录？")
        return tracks, warnings

    if MutagenFile is None:
        raise SystemExit("读普通音频的标签需要 mutagen：py -3 -m pip install mutagen"
                         "（或者用 --bili 读 B 站缓存，那条路不碰标签库）")
    tracks, warnings = [], []
    for path in sorted(folder.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in SUFFIXES:
            continue
        if any(part.startswith(".") for part in path.relative_to(folder).parts):
            continue
        track, notes = describe(path, folder)
        warnings.extend(notes)
        tracks.append(track)
    return tracks, warnings


def by_length(tracks, min_seconds, max_minutes, keep_long):
    """The radio's own rules: no jingles, no two-hour sets — unless you say it is a set."""
    selected, short, long_runs = [], [], []
    for track in tracks:
        if any(needle in track["key"] or needle in track["title"] for needle in keep_long):
            selected.append(track)
            continue
        # An unknown length is not a short one: keep it, the notes already say so.
        duration = track["duration"]
        if duration and min_seconds and duration < min_seconds:
            short.append(track)
        elif duration and max_minutes and duration > max_minutes * 60:
            long_runs.append(track)
        else:
            selected.append(track)
    return selected, short, long_runs


def show(minutes, tracks):
    for track in tracks[:8]:
        print(f"  ! {minutes}: {track['duration'] / 60:.1f}min  {track['title'][:40]} — {track['artist']}")
    if len(tracks) > 8:
        print(f"  ! {minutes}: 另有 {len(tracks) - 8} 首同类")


def main():
    parser = argparse.ArgumentParser(description="Generate the committed music manifest.")
    parser.add_argument("folder", type=Path)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--bili", action="store_true",
                        help="按 B 站缓存读：<avid>/<c_cid>/entry.json，标题取分 P 名")
    parser.add_argument("--min-seconds", type=float, default=None,
                        help="短于此时长的不要（--bili 默认 30，普通模式默认不限）")
    parser.add_argument("--max-minutes", type=float, default=None,
                        help="长于此分钟数的不要（--bili 默认 60，普通模式默认不限）")
    parser.add_argument("--keep-long", action="append", default=[], metavar="子串",
                        help="key 或标题里含这个子串的歌单无视上限保留（多首歌合成一首）")
    parser.add_argument("--stage", type=Path, default=None,
                        help="另外做一棵只含音频的硬链接树，给上传工具用；key 与清单一致")
    args = parser.parse_args()

    folder = args.folder.expanduser().resolve()
    if not folder.is_dir():
        raise SystemExit(f"没有这个文件夹：{folder}")

    min_seconds = args.min_seconds
    max_minutes = args.max_minutes
    if min_seconds is None:
        min_seconds = BILI_MIN_SECONDS if args.bili else 0
    if max_minutes is None:
        max_minutes = BILI_MAX_MINUTES if args.bili else 0

    found, warnings = collect(folder, args.bili)
    tracks, short, long_runs = by_length(found, min_seconds, max_minutes, args.keep_long)

    if not tracks:
        raise SystemExit(f"{folder} 里没有可识别的音频文件")

    ids = {}
    for track in tracks:
        if track["id"] in ids:
            warnings.append(f"{track['key']}: 与 {ids[track['id']]} 的 id 冲突")
        ids[track["id"]] = track["key"]

    tracks.sort(key=lambda t: (t["side"], t["track"] or 10**6, t["title"], t["key"]))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(render(tracks), encoding="utf-8")

    total = sum(t["bytes"] for t in tracks)
    seconds = int(sum(t["duration"] for t in tracks))
    formats = {}
    for track in tracks:
        formats[track["format"]] = formats.get(track["format"], 0) + 1

    print(f"tracks: {len(tracks)}   size: {total / 1073741824:.2f} GiB"
          f"   playtime: {seconds // 3600}h{seconds % 3600 // 60:02d}m")
    print("formats: " + ", ".join(f"{k} x{v}" for k, v in sorted(formats.items())))
    try:
        shown = args.out.resolve().relative_to(ROOT)
    except ValueError:
        shown = args.out
    print(f"sides: {len({t['side'] for t in tracks})}   output: {shown}")

    if short or long_runs:
        rule = f"短于 {min_seconds:g}s" if min_seconds else ""
        rule += "、" if short and long_runs else ""
        rule += f"长于 {max_minutes:g}min" if max_minutes else ""
        print(f"按时长规则剔掉 {len(short) + len(long_runs)} 首（{rule}）；"
              f"合并曲用 --keep-long <key或标题子串> 放行")
        show("太短", short)
        show("太长", long_runs)

    if args.stage:
        stage_dir = args.stage.expanduser().resolve()
        made = stage_audio(tracks, folder, stage_dir)
        print(f"暂存树：{stage_dir}   新建 {made} / {len(tracks)} 个文件")

    chars = visible_chars(tracks)
    if chars:
        sample = "".join(sorted(chars))
        print(f"字形: 标签里出现 {len(chars)} 个非 ASCII 字符（{sample[:60]}）")
        print("      重跑 tools/font_faces.py 把它们并进 core 面，否则读者会下载 1.4 MB 的 fill 面。")
    for note in warnings[:20]:
        print(f"  ! {note}")
    if len(warnings) > 20:
        print(f"  ! 另有 {len(warnings) - 20} 条同类提示")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
