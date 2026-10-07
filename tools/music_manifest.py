"""Build the committed track list for the radio, from a folder of audio files.

The audio never enters git: the 400 files live in a private Cloudflare R2 bucket,
and this tool only reads their tags locally to write src/data/music.json, which is
what the site ships. Each entry keeps both the R2 object key (the path relative to
the folder you point at) and an opaque ASCII id, so /track/<id> URLs never have to
carry a Chinese filename.

    py -3 tools/music_manifest.py D:\\Music\\Chandelier

Output is sorted and carries no timestamp, so re-running it only shows real changes.
After it reports new characters, rebuild the core font face (tools/font_faces.py) or
those titles will pull the 1.4 MB fill face at runtime.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

try:
    from mutagen import File as MutagenFile
except ImportError:
    raise SystemExit("mutagen is required: py -3 -m pip install mutagen")

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "src" / "data" / "music.json"
SUFFIXES = {".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".m4b", ".aac",
            ".wav", ".aif", ".aiff", ".wma", ".ape", ".mp4", ".m4v", ".mka"}
ID_LENGTH = 12
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


def build(path, folder, title, artist, album, year, number, duration, kind):
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
        "side": top or album or "未分类",
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


def visible_chars(tracks):
    fields = ("title", "artist", "album", "side")
    text = "".join(str(track[field]) for track in tracks for field in fields if track[field])
    return {c for c in text if ord(c) > 0x7F and not ("\ud800" <= c <= "\udfff")}


def main():
    parser = argparse.ArgumentParser(description="Generate the committed music manifest.")
    parser.add_argument("folder", type=Path)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    folder = args.folder.expanduser().resolve()
    if not folder.is_dir():
        raise SystemExit(f"没有这个文件夹：{folder}")

    tracks, warnings, ids = [], [], {}
    for path in sorted(folder.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in SUFFIXES:
            continue
        if any(part.startswith(".") for part in path.relative_to(folder).parts):
            continue
        track, notes = describe(path, folder)
        warnings.extend(notes)
        if track["id"] in ids:
            warnings.append(f"{track['key']}: 与 {ids[track['id']]} 的 id 冲突")
        ids[track["id"]] = track["key"]
        tracks.append(track)

    if not tracks:
        raise SystemExit(f"{folder} 里没有可识别的音频文件")

    tracks.sort(key=lambda t: (t["side"], t["track"] or 10**6, t["title"], t["key"]))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"tracks": tracks}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

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
