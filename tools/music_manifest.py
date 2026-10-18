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
(the P name) — or, when that P name is only the file the uploader dragged in
(`studio_video_….mp4`, `P1`, `….副本(1)`), from the video's own title with the P
number appended, because a crate full of filenames tells you nothing. Its author
comes from `owner_name`, its length from `total_time_milli`, and the bytes come
from the highest quality `audio.m4s` under it. Video, cover and danmaku files are
ignored, and no tag reader is needed, so mutagen stays optional. Titles are display
fields: `key` and `id` are derived from the stored path only, so renaming costs no
re-upload.

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
import re
import shutil
import sys
import unicodedata
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


# 风格标签：缓存里没有 genre 这个字段，只能从标题 / UP 主 / 视频标题里猜。规则按顺序
# 命中，第一条赢，所以越具体的放前面（「伴奏」比「纯音乐」更准，「初音ミク」比「日语」更准）。
# 关键词一律小写比对；宁可落到「其他」，也不要为了填满而把一首歌塞进错的那一格。
GENRE_RULES = (
    ("伴奏", ("伴奏", "instrumental", "inst版", "分轨", "纯享", "去人声", "无人声", "ktv", "消音",
               "消人声", "tracklib", "backing track")),
    ("鬼畜", ("鬼畜", "音mad", "mad", "全明星", "电棍", "梁逸峰", "王司徒", "诸葛亮", "金坷垃",
                 "ilem", "普通disco", "摆渡", "井盖", "high歌", "葫芦娃", "恶搞", "空耳", "抽象",
                 "圣经", "语录", "名场面", "鬼才", "neta", "整活", "鬼畜调教", "整大活", "抽象圣经",
                 "♿", "冷知识", "拼好歌", "让子弹飞")),
    ("术力口", ("vocaloid", "ボカロ", "初音", "ミク", "miku", "镜音", "鏡音", "巡音", "ルカ", "meiko",
               "kaito", "gumi", "synthv", "vsinger", "utau", "声库", "音源", "重音", "テト", "teto",
               "音街", "ウナ", "可不", "kafu", "flower", "結月", "ゆかり", "東北", "きりたん", "ずんだ",
               "心愛", "歌愛", "里命", "東雲", "洛天依", "言和", "乐正", "星尘", "海伊", "苍穹", "カササギ", "柿崎", "r-906",
               "墨清弦", "徵羽", "心华", "梦nex", "歌衣", "v4x", "v3", "sv", "本家", "官方投稿", "acesind",
               "いよわ", "chinozo", "mili", "toboe", "wowaka", "40m-p", "40mp", "n-buna", "kairikib",
               "aqu3ra", "柊magnet", "柊マグネット", "kanaria", "v flower", "うたた歌衣",
               "术力口", "v家", "p主", "歌い手", "春嵐", "春岚", "神のまにまに", "神的随波逐流",
               "メズマライザー", "パノプティコン", "圆形监狱", "千本桜")),
    ("游戏", ("tno", "hoi4", "钢铁雄心", "paradox", "欧陆风云", "维多利亚", "eu4", "原声音乐",
               "bgm", "ost", "vgm", "游戏", "arcaea", "osu", "deemo", "cytus", "djmax", "malody",
               "phigros", "chunithm", "maimai", "世界计划", "sekai", "谱面", "音游", "太鼓",
               "minecraft", "原神", "崩坏", "星穹", "绝区零", "鸣潮", "明日方舟", "arknights",
               "第五人格", "蛋仔", "泰拉瑞亚", "星露谷", "宝可梦", "pokemon", "任天堂", "mario",
               "塞尔达", "最终幻想", "ff14", "怪物猎人", "只狼", "艾尔登", "黑神话", "英雄联盟",
               "魔兽", "星际争霸", "红警", "命令与征服", "战争雷霆", "使命召唤", "战地", "halo",
               "cs2", "counter-strike", "battlefield", "buckshot",
               "东方", "touhou", "上海アリス", "zun", "节奏大师", "世界计划p", "bofu", "bms", "节奏光剑",
               "bad apple")),
    ("番剧", ("电影", "影视", "电视剧", "纪录片", "综艺", "剧场版", "动画", "动漫", "番剧",
               "日剧", "韩剧", "片头", "片尾", "主题曲", "插曲", "配乐", "原声带", "电影原声",
               "星际穿越", "interstellar", "hans", "季默", "久石让", "久石讓", "坂本龙一", "坂本龍一",
               "泽野", "川井", "菅野", "梶浦", "新海诚", "吉卜力", "攻壳", "eva", "魔禁", "假面骑士",
               "奥特曼", "进击", "鬼灭", "咒术", "海贼", "火影", "死神", "柯南", "龙珠", "灌篮",
               "钢炼", "东京喰种", "全职猎人", "你的名字", "天气之子", "铃芽", "千与千寻", "龙猫",
               "天空之城", "哈尔", "泰坦尼克", "教父", "漫威", "权力的游戏", "怪奇物语", "op1", "op2",
               "ed1", "ed2", "op完整", "ed完整", "insert song", "角色歌", "アニメ", "amv", "特摄", "主題歌",
               "fate", "幸运星")),
    ("红歌", ("苏联", "蘇聯", "游击队", "游擊隊", "国际歌", "喀秋莎", "建军", "国庆", "国歌",
               "南斯拉夫", "冷战", "进行曲", "东方红", "十送", "我的祖国", "黄河大", "长征", "钢铁",
               "近卫", "红旗", "军歌", "军盲", "红军", "抗日", "志愿军", "祖国", "颂歌", "社会主义",
               "莫斯科", "德意志", "第三帝国", "内战", "反统一", "革命", "共青团", "苏维埃", "东德",
               "西德", "人民", "魏玛", "布尔什维克", "无产者", "国际悲歌",
               "左翼", "反战", "共产", "列宁", "伊里奇", "斯大林", "托洛茨基", "胜利日", "起义", "worker",
               "游击", "抗战", "英雄主义", "保卫黄河", "黄河", "斯拉夫", "古田", "忠骨", "aufmarsch",
               "freikorps", "国际纵队", "华沙", "工人",
               "fdj", "internationale", "自由德国青年", "钢铁洪流", "喀山", "基辅", "柏林", "国会", "燃烧吧", "营歌",
               "朋友再见", "独立战争", "扬基歌", "百团大战", "草原啊草原")),
    ("古典", ("古典", "交响", "交響", "协奏", "協奏", "奏鸣", "奏鳴", "安魂", "requiem", "弥撒",
            "咏叹", "歌剧", "赋格", "fugue", "夜曲", "圆舞曲", "前奏曲", "室内乐", "钢琴曲", "鋼琴",
            "小提琴", "大提琴", "贝多芬", "beethoven", "莫扎特", "mozart", "巴赫",
            "bach", "肖邦", "chopin", "李斯特", "德彪西", "柴可夫斯基", "tchaikovsky", "拉赫",
            "德沃夏克", "维瓦尔", "亨德尔", "勃拉姆斯", "舒伯特", "舒曼", "圣桑",
            "格里格", "西贝柳斯", "马勒", "印象派", "穆索尔斯基", "图画展览会", "五重奏", "四重奏",
            "铜管", "管弦", "弦乐")),
    ("说唱", ("rap", "hip hop", "hip-hop", "hiphop", "说唱", "trap", "boombap", "boom bap", "drill",
            "freestyle", "diss", "mc", "eminem", "姆爷", "谢帝", "功夫胖", "cbloc", "c-block", "gai",
            "诺米", "阴三", "派克特", "法老", "揽佬", "唐川", "老幺", "活死人", "说唱新世代",
            "中国新说唱", "street rap", "punchline")),
    ("后朋·金属", ("摇滚", "搖滾", "后朋", "punk", "metal", "rock", "乐队", "樂團", "金属", "金屬",
               "死金", "黑金", "旋死", "金属核", "硬核", "grunge", "emo", "英伦", "britpop",
               "indie", "独立音乐", "dream pop", "shoegaze", "post rock", "math rock", "nirvana",
               "linkin", "queen", "beatles", "平克", "电台司令", "muse", "beyond", "五月天", "万青",
               "痛仰", "新裤子", "草东", "no party", "枪与玫瑰", "嘶吼", "吉他英雄", "riff",
               "crimson", "king crimson", "国摇", "post punk", "post-punk", "后摇",
               "万能青年旅店", "回春丹", "犬儒乐队", "沉舟", "大石碎胸口",
               "molchat doma", "молчат")),
    ("电音", ("电子", "電音", "电音", "edm", "synthwave", "retrowave", "蒸汽波", "vapor", "maretu",
            "funk", "phunk", "mashup", "bootleg", "remix", "slowed", "speed up", "montagem",
            "phonk", "hardstyle", "hardcore", "tano*c", "techno", "trance", "house", "dubstep",
            "future bass", "riddim", "dnb", "drum and bass", "breakcore", "breakbeat", "gabber",
            "jungle", "glitch", "electro", "synth", "arpeggio", "sequencer", "acid", "eurobeat",
            "hyperpop", "nightcore", "city pop", "disco", "迪斯科", "ambient", "lofi", "lo-fi",
            "chill", "808", "jersey club", "赛博", "mix", "miraidempa", "未来電波", "未来电波",
            "合成器浪潮", "合成器", "hardtekk", "tekk", "funkot", "astro slide", "frums", "⚡")),
    ("民族", ("民谣", "民歌", "童谣", "儿歌", "摇篮曲", "蒙古", "呼麦", "维语", "藏语", "侗族",
               "苗族", "彝族", "三弦", "马头琴", "古琴", "古筝", "琵琶", "笛子", "二胡", "箫", "埙",
               "爵士", "jazz", "bossa", "flamenco", "拉丁", "samba", "tango", "reggae", "country",
               "乡村", "非洲", "凯尔特", "风笛", "苏格兰", "爱尔兰", "巴尔干", "克莱兹默", "俄罗斯",
               "俄语", "意大利", "法兰西", "法语", "德意志民歌", "印尼", "甘美兰", "gamelan", "印度",
               "阿拉伯", "土耳其", "犹太", "演歌", "邦乐", "和乐器", "民族乐", "k-pop", "kpop", "j-pop", "jpop",
               "乡间的小路", "荡起双桨", "卓依婷")),
    ("翻唱", ("翻唱", "cover", "填词", "中文版", "国语版", "粤语", "台语", "人声版", "重唱",
               "现场", "live", "演唱会", "合唱", "二重唱", "对唱", "清唱", "a cappella", "acapella",
               "acoustic", "不插电", "哼唱", "重新编曲", "改编", "二创", "翻自", "翻弹", "vocal ver")),
    ("纯音", ("纯音乐", "純音樂", "纯音", "器乐", "器樂", "独奏", "指弹", "无词", "曲集", "钢琴版",
             "八音盒", "音乐盒", "輕音樂", "轻音乐", "背景音", "助眠", "学习", "piano ver",
             "background music", "instrumental version")),
    ("流行", ("流行", "华语", "国语", "粤语歌", "欧美", "日韩", "日推", "歌单", "榜单", "金曲",
               "经典", "老歌", "怀旧", "情歌", "神曲", "网络歌曲", "抖音", "ballad", "pop", "r&b",
               "soul", "女声", "男声", "hi-res", "hires", "黑胶", "百万级", "试听", "无损", "发烧", "推荐", "循环", "必听", "单曲",
               "cd音质", "磁带音质", "remastered", "录音棚", "豪装", "大声听", "jlrs",
               "字幕", "中字", "双语", "熟肉", "official video", "official audio", "music video",
               "just the two of us", "tom cardy", "bo burnham", "nina simone", "bill withers",
               "lemon tree", "英文歌", "日语歌", "daisy bell", "布施明", "李叔同", "送别", "imase")),
)
GENRE_FALLBACK = "其他"

# 曲名：B 站缓存里每个 <avid>/<c_cid>/entry.json 顶层的 title 是人打的视频标题，
# page_data.part 是分 P 名——而分 P 名经常只是上传时留下的文件名
# （studio_video_1732298075901.mp4、lv_0_20260703111445、1638539221804、P1、
# 202110170856-副本-副本 (1)-副本、- YouTube(1)）。这种名字在电台里等于「完全不知道是啥」，
# 所以命中文件名形状的一律改用视频标题，同一稿件有多个 P 时再补 P 号区分。
# 只改展示用的曲名：key 与 id 都不动，因此不需要重传音频。

# 判断「这串是不是文件名」时先把它能拆掉的噪音全拆光，剩下没有一个字母就算文件名。
# 这张表只用于识别，不参与改写，所以宁可写宽一点。
TITLE_NOISE = re.compile(
    r"""(?ix)
      mp4 | m4v | mkv | avi | flv | mov | webm | m4a | m4b | mp3 | wav | flac | ape |
      ogg | opus | wma | m4s | aac | x26[45] | h26[45] | hevc | avc | \d{2,3}\s*fps |
      \d{3,4}\s*p | 4k | 8k | fhd | hd |
      studio | video | audio | slide | export(?:ed)? | edit(?:ed)? | final | draft |
      temp | capture | screen(?:shot)? | record(?:ed)? | render | clip | intro | outro |
      youtube | youtu | bilibili | douyin | kuaishou | weixin | wechat | niconico | astro |
      mmexport | shazam | itunes | vlcsnap | vid(?=\d) | \[[0-9a-f]{4,10}\] |
      ニコニコ | 動画 | 副本 | 复件 | 拷贝 | 复制 | 重命名 | 已恢复 | 修改 | 最终(?:版)? |
      新建 | 项目 | 新项目 | 文件夹 | 模板 | 完整版? | 未命名 | 无标题 | 测试 | 备份 | 音乐 | 歌曲? | 视频 | 纯享 | 片段 |
      lv | rec | mv | pv | part | page | p
    | \d+
    | [_\-.·、|｜~!@#%^*()（）\[\]【】{}<>《》"'\s]+
    """)
# 「有没有人写的字」不能问 isalpha()：它对汉字返回 False（会把「在虚无中永存」判成文件名），
# 对 ﾟ 这类半角假名标点返回 True（会把 mmexport 剩下的残渣当曲名）。只认各脚本的真字母。
SCRIPT_LETTER = re.compile(
    r"[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u05D0-\u05FF\u0600-\u06FF"
    r"\u3041-\u309F\u30A1-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF"
    r"\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFF9D]")
# 改写只用这一小撮规则，和上面那张识别表分开：识别可以宽，动手必须窄。
EXTENSION_TAIL = re.compile(r"(?i)\.(?:mp4|m4v|mkv|avi|flv|mov|webm|m4a|m4b|mp3|wav|flac|ape|ogg|opus|wma|m4s|aac)\s*$")
SAVE_AS_TAIL = re.compile(r"(?i)(?:\s*[-_ ]?(?:副本|复件|拷贝))+|(?:\s*\(\d{1,2}\))+(?=$|\s)")
PLATFORM_TAIL = re.compile(r"(?i)[-—–\s](?:youtube|youtu\.?be|niconico|ニコニコ(?:動画)?|bilibili|b站)\s*(?:\(\d{1,2}\))?\s*$")
CODEC_TAIL = re.compile(r"(?i)(?:[-_ ](?:x26[45]|h26[45]|hevc|avc|\d{2,3}fps|\d{3,4}p|4k|8k|vimeo))+\s*$")
# 导出计数尾巴：BHO Cover_2、Matra_exported_0。只认下划线，'Song 2' 那种真空格不动。
COUNTER_TAIL = re.compile(r"_[0-9]{1,3}\s*$")
# 画质标签打在开头或结尾都算：【4K60FPS】歌名、歌名【Hi-Res 24bit/192kHz】。
QUALITY_HEAD = re.compile(r"^\s*[【\[（(]([^\]）)】]{1,26})[】\]）)]\s*")
QUALITY_TAIL = re.compile(r"\s*[【\[（(]([^\]）)】]{1,26})[】\]）)]\s*$")
# 画质标签是可以连着写的（【4K60FPS/360º全景视角/3D环绕音】、【Hi-Res 24bit/192kHz】），
# 所以整串 token 必须逐个落在下面这张表里，有一个词不在表里就整串保留——
# 【中日歌词/OP完整版】那种是内容说明，剪掉就把人想说的东西剪没了。
QUALITY_TOKEN = re.compile(
    r"(?i)^(?:"
    r"\d+[kK][hH][zZ]|\d+[kK]\d*[fF]?[pP]?[sS]?|\d+[fF][pP][sS]|\d{3,4}[pP]|360[º°]|\d{1,2}bit|"
    r"超清|高清|高画质|高帧率|无损|高音质|音质|杜比视界|杜比全景声|杜比|dolby(?:vision|atmos)?|atmos|"
    r"hi-?res|空间音频|全景声|全景视角|环绕音|3d环绕音|全记录|收藏向|建议收藏|补档|完整[版程]|官方[版MV]?|熟肉"
    r")+$"
)
INVISIBLE = str.maketrans({code: None for code in (
    0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff)})
MATH_ALNUM = re.compile(r"[\U0001d400-\U0001d7ff]")


def looks_like_filename(text):
    """拆掉所有噪音后连一个真字母都不剩，就说明这串不是人写的曲名。"""
    return not SCRIPT_LETTER.search(TITLE_NOISE.sub("", str(text or "")))


def tidy_title(text):
    """曲名只留人能看的部分。

    装饰字母（𝗢𝗢𝗣𝗦、𝑺𝑻𝑬𝑷𝑷𝑰𝑵𝑮）先折回 ASCII——它们既搜不到、字体面里也没有；
    再剪掉扩展名、Windows 另存为链、平台尾巴和两头那串画质标签（【4K60FPS/3D环绕音】）。
    """
    value = str(text or "").translate(INVISIBLE)
    value = MATH_ALNUM.sub(lambda ch: unicodedata.normalize("NFKC", ch.group()), value)
    value = EXTENSION_TAIL.sub("", value)
    value = SAVE_AS_TAIL.sub("", value)
    value = PLATFORM_TAIL.sub("", value)
    value = CODEC_TAIL.sub("", value)
    value = COUNTER_TAIL.sub("", value)
    if value.count("_") >= 3:          # 下划线墙：MONTAGEM_FEARLESS_Ultra_Slowed-lirvie_DJ_…
        value = re.sub(r"_+", " ", value)
    while True:                        # 连着两层也剪：【4K】【Hi-Res】歌名【无损】
        head = QUALITY_HEAD.match(value)
        if head and is_quality_bracket(head.group(1)):
            value = value[head.end():]
            continue
        tail = QUALITY_TAIL.search(value)
        if tail and is_quality_bracket(tail.group(1)):
            value = value[:tail.start()]
            continue
        break
    value = re.sub(r"\s{2,}", " ", value)
    return value.strip(" \t-–—_·.、|｜/\\，,")


def is_quality_bracket(content):
    """括号里每个词都是画质/收藏话术才算标签；混进一个内容词（中日歌词）就整串保留。"""
    tokens = [token for token in re.split(r"[/｜|、,，\s]+", content) if token]
    return bool(tokens) and all(QUALITY_TOKEN.match(token) for token in tokens)


def bili_titles(part, video, fallback):
    """分 P 名是文件名时改用视频标题。

    视频标题自己也得先过一遍检查：确实有投稿拿零宽字符和装饰符号当标题
    （`title='⁣'`），那种只能给个占位名——总比让 build() 退回文件 stem 的「audio」强。
    返回的第二个值是「名字来自视频那一层」，决定要不要补 P 号区分。
    """
    part, video = tidy_title(part), tidy_title(video)
    if not looks_like_filename(part):
        return part, False
    if SCRIPT_LETTER.search(video) and not looks_like_filename(video):
        return video, True
    return fallback, True


_MATCHES = {}


def _hit(word, haystack):
    """Latin keywords need word boundaries: plain substring matching let "deo"
    inside "video" and "live" inside "believe" claim tracks they never touched."""
    if word.isascii():
        pattern = _MATCHES.get(word)
        if pattern is None:
            pattern = _MATCHES.setdefault(word, re.compile(r"(?<![0-9a-z])%s(?![0-9a-z])" % re.escape(word)))
        return pattern.search(haystack) is not None
    return word in haystack


def classify_genre(title, artist, album, side=""):
    fields = tuple(str(part or "").lower() for part in (title, artist, album, side))
    for label, words in GENRE_RULES:
        if any(_hit(word, part) for word in words for part in fields):
            return label
    # 兜底：这批缓存里的西里尔字母标题几乎都是苏/德系军歌（《哎，小苹果》那一类），
    # 而它们一个中文关键词都不带。只在别的规则全落空时才这么判。
    if any("Ѐ" <= c <= "я" for part in fields for c in part):
        return "红歌"
    return GENRE_FALLBACK


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
    side = side or top or album or "未分类"
    return {
        "id": hashlib.sha1(rel.encode("utf-8")).hexdigest()[:ID_LENGTH],
        "key": rel,
        "title": title or path.stem,
        "artist": artist,
        "album": album,
        "year": year or None,
        "track": number or None,
        "side": side,
        "genre": classify_genre(title or path.stem, artist, album, side),
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
    artist = str(data.get("owner_name") or "").strip()
    album = tidy_title(data.get("title"))
    unnamed = f"未命名 · {data.get('bvid') or entry_path.parent.name}"
    title, replaced = bili_titles(page.get("part"), data.get("title"), unnamed)
    number = page.get("page") if isinstance(page.get("page"), int) else None
    try:
        duration = round(float(data.get("total_time_milli") or 0) / 1000, 2)
    except (TypeError, ValueError):
        duration = 0.0

    track = build(audio, folder, title, artist, album, 0, number, duration, "m4s",
                  side=artist or album)
    if replaced:
        track["from_video"] = True
    notes = []
    if title == unnamed:
        notes.append(f"{track['key']}: 分 P 名和视频标题都是空的（多半是零宽字符），用 BV 号占位")
    if not duration:
        notes.append(f"{track['key']}: entry.json 没有时长")
    if not data.get("is_completed"):
        notes.append(f"{track['key']}: 缓存没标记完成，仍然入表")
    return track, notes


def _colliding(tracks):
    """同一批里名字重复的那些条目。"""
    counts = {}
    for track in tracks:
        counts[track["title"]] = counts.get(track["title"], 0) + 1
    return [track for track in tracks if counts[track["title"]] > 1]


def disambiguate_parts(tracks):
    """撞名的曲名分开：同稿补 P 号，跨稿件改用各自的视频标题。

    分 P 名是上传时的文件名时先换成视频标题，换完可能同一稿全同名（只能靠 P 号分开），
    也可能几个独立稿件撞在一起——CS2 音乐盒那一类的分 P 名都叫「主界面」，
    只有视频标题能看出是哪一首。
    返回（改用视频标题的首数, 补了 P 号的首数）。
    """
    groups = {}
    for track in tracks:
        groups.setdefault(track["key"].split("/", 1)[0], []).append(track)

    replaced = suffixed = 0
    for same_video in groups.values():
        replaced += sum(bool(track.pop("from_video", False)) for track in same_video)
        if len(same_video) < 2:
            continue
        for track in _colliding(same_video):
            if track["track"]:
                track["title"] = f"{track['title']} P{track['track']}"
                suffixed += 1

    for track in _colliding(tracks):                 # 剩下的重名来自不同稿件
        album = str(track["album"] or "")
        if album and album != track["title"] and len(album) <= 90 and not looks_like_filename(album):
            track["title"] = album
            replaced += 1

    # build() 里的风格是按改之前的曲名算的，改完名要重算一遍
    for track in tracks:
        track["genre"] = classify_genre(track["title"], track["artist"], track["album"], track["side"])
    return replaced, suffixed


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
    fields = ("title", "artist", "album", "side", "genre")
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
        renamed, numbered = disambiguate_parts(tracks)
        if renamed:
            warnings.append(f"{renamed} 首的分 P 名是上传时的文件名，已改用视频标题或占位名"
                            f"（其中 {numbered} 首按 P 号区分）")
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
