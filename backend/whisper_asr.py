"""本地 Whisper 转写：替换腾讯云「一句话识别」，对外保持与 podcast_asr 完全相同的契约。

对外只暴露 `transcribe_audio(path, asr, source_language, on_progress) -> [{start, end, text}]`，
start/end 为秒。因此 backend/main.py 只需换一行调用即可切换引擎。

为什么这样设计（依据 2026-09 在本项目语料上的实测结论）：

1. **不能「VAD 切段 → 每段单独喂 Whisper」。**
   openai-whisper 每次 `transcribe()` 都会把输入 pad/trim 到 30 秒 mel
   （`N_FRAMES = 3000`）。现有 VAD 在 874s 音频上按 merge_gap=400ms 切出约 190 段，
   每段 3 秒也要走完整的 30 秒 encoder 前向 → 等效计算量约 ×6.5，
   M1 上 base 从 ~4 分钟膨胀到 ~25 分钟。
   且短段上下文不足会让法语质量更差（podcast_asr.py 已实测 <1.0s 段失败率 33%）。

2. **不能直接用 Whisper 原生 segment。**
   原生 segment 粒度 5~30s、边界与句子不对齐，精听的高亮/跳转体验会崩坏。

3. 所以走第三条路：**整文件（分块）转写一次 + `word_timestamps=True`，
   再用「句末标点 / 词间静音 / 时长与字数上限」三重规则二次切句。**
   时间戳直接来自词级结果，不做任何文本↔时间的推断对齐。

4. **解码走 `podcast_asr.decode_to_pcm16k`（PyAV），不依赖 ffmpeg CLI。**
   `whisper.load_audio()` 会 shell 调用 ffmpeg，而本机 ffmpeg 装在
   `/opt/homebrew/bin`，不在非登录 shell 的 PATH 里，worker 由 launchd 拉起时必然失败。

5. **`condition_on_previous_text=False` 是必须的。**
   默认 True 时 Whisper 会在音乐/静音处整段重复输出（实测出现连续两行完全相同的文本）。

6. **分块而不是整文件一次跑。** 长音频整文件跑会让前端进度条几分钟不动，
   且峰值内存随音频长度线性增长。分块（默认 300s）后每块结束回调一次进度；
   切点会在 ±8s 内吸附到能量最低的 30ms 帧，避免把词从中间切断。
"""

from __future__ import annotations

import os
import threading

import numpy as np
from dotenv import load_dotenv

import podcast_asr

# 与 main.py 相同的加载顺序：先仓库根 .env，再当前工作目录 .env（都不覆盖已有值）。
#
# 必须放在本模块读取任何配置**之前**。原因：main.py 是「先 import 本模块、
# 后 load_dotenv」，如果这里不自己加载，下面所有 os.getenv 都会读到未初始化的
# 环境，把 WHISPER_MODEL=base 之类的设置静默退回默认值。
# load_dotenv 默认 override=False，重复调用是幂等的。
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_REPO_ROOT, ".env"))
load_dotenv()

SAMPLE_RATE = 16000

# base（145MB，已缓存）| small（~461MB，法语明显更准）| medium | large-v3-turbo
DEFAULT_MODEL = os.getenv("WHISPER_MODEL", "small")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")

# 单句时长/字数上限：超过就切开，保证精听的定位粒度
MAX_SEGMENT_SEC = float(os.getenv("WHISPER_MAX_SEGMENT_SEC", "12"))
MAX_SEGMENT_CHARS = int(os.getenv("WHISPER_MAX_SEGMENT_CHARS", "180"))
# 词间静音超过该值即视为句子边界
WORD_GAP_SEC = float(os.getenv("WHISPER_WORD_GAP_SEC", "0.6"))
# 幻觉抑制：no_speech 概率高于该值的窗口直接丢弃
NO_SPEECH_THRESHOLD = float(os.getenv("WHISPER_NO_SPEECH_THRESHOLD", "0.6"))
# 分块长度与切点吸附搜索半径（秒）
CHUNK_SEC = float(os.getenv("WHISPER_CHUNK_SEC", "300"))
SNAP_SEARCH_SEC = float(os.getenv("WHISPER_SNAP_SEARCH_SEC", "8"))
# 混合语言内容（英语讲解 + 法语示范）开双遍裁决；单语种内容固定语种可省一半时间。
# 实测双遍只有 13/205 行有实质差异、却要多花 1.77× 时间，且 small 的逐窗自动检测
# 已能正确处理混排内容，故默认关闭。少数语种被主导语种带坏时再打开。
BILINGUAL = os.getenv("WHISPER_BILINGUAL", "0").strip().lower() not in (
    "0", "false", "no", "",
)

# P0-3：异常短输出检测阈值（独立于语种，兜底"只出 1 句"类事故）。
# 任一信号越界即判异常；异常且可重试时换语种重跑一遍。
ANOMALY_MIN_DURATION_SEC = float(os.getenv("WHISPER_ANOMALY_MIN_DURATION_SEC", "30"))
ANOMALY_MAX_NO_SPEECH = float(os.getenv("WHISPER_ANOMALY_MAX_NO_SPEECH", "0.85"))
ANOMALY_MIN_COVERAGE = float(os.getenv("WHISPER_ANOMALY_MIN_COVERAGE", "0.15"))
ANOMALY_MIN_LOGPROB = float(os.getenv("WHISPER_ANOMALY_MIN_LOGPROB", "-1.3"))
ANOMALY_MAX_COMPRESSION = float(os.getenv("WHISPER_ANOMALY_MAX_COMPRESSION", "2.8"))
# 关闭后异常只报错、不自动重试
ANOMALY_RETRY_ENABLED = os.getenv("WHISPER_ANOMALY_RETRY", "1").strip().lower() not in (
    "0", "false", "no", "",
)

# P0-2：auto 模式下多锚点语种预检（轻量版，不引入 P1 全量多锚点转写）。
# 头/中/尾各取 30s 做一次 detect_language，明显是中文则提前强制 zh，
# 省去 P0-3「整段塌缩 → 换语种重跑」的 2x 开销。P0-3 仍作兜底。
WHISPER_AUTO_ZH_FALLBACK = os.getenv("WHISPER_AUTO_ZH_FALLBACK", "1").strip().lower() not in (
    "0", "false", "no", "",
)
AUTO_ZH_MIN_PROB = float(os.getenv("WHISPER_AUTO_ZH_MIN_PROB", "0.6"))
# P1：非中文锚点要「全一致且都高置信」才强制，避免盖掉 whisper 原生 auto
AUTO_OTHER_MIN_PROB = float(os.getenv("WHISPER_AUTO_OTHER_MIN_PROB", "0.7"))

_model = None
_model_lock = threading.Lock()


def get_model():
    """进程内单例。首次调用会加载模型（base 约 1~3s，small 约 3~8s）。"""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                import torch
                import whisper

                threads = os.getenv("WHISPER_THREADS", "").strip()
                count = int(threads) if threads else min(8, os.cpu_count() or 4)
                torch.set_num_threads(max(1, count))
                _model = whisper.load_model(DEFAULT_MODEL, device=DEVICE)
    return _model


# --------------------------------------------------------------------------
# 解码与分块
# --------------------------------------------------------------------------

def _load_audio_f32(path: str) -> np.ndarray:
    """任意音频 -> 16kHz 单声道 float32（Whisper 期望的输入格式）。"""
    pcm = podcast_asr.decode_to_pcm16k(path)
    if not pcm:
        raise podcast_asr.ASRError("音频解码为空")
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


def _quiet_boundary(audio: np.ndarray, nominal: int, search_sec: float) -> int:
    """在 nominal ± search_sec 内找能量最低的 30ms 帧，返回其中心样本下标。"""
    frame = int(0.03 * SAMPLE_RATE)
    half = int(search_sec * SAMPLE_RATE)
    low = max(0, nominal - half)
    high = min(len(audio), nominal + half)
    if high - low < frame * 2:
        return nominal

    window = audio[low:high].astype(np.float64)
    count = len(window) // frame
    if count < 1:
        return nominal
    frames = window[: count * frame].reshape(count, frame)
    energy = np.sqrt((frames ** 2).mean(axis=1))
    return low + int(energy.argmin()) * frame + frame // 2


def _chunk_ranges(audio: np.ndarray) -> list[tuple[int, int]]:
    """把整段音频切成 [(start_sample, end_sample)]，切点吸附到低能量处。"""
    total = len(audio)
    chunk = int(CHUNK_SEC * SAMPLE_RATE)
    if total <= chunk or chunk <= 0:
        return [(0, total)]

    bounds = [0]
    position = chunk
    while position < total:
        bounds.append(_quiet_boundary(audio, position, SNAP_SEARCH_SEC))
        position += chunk
    bounds.append(total)

    # 吸附后仍严格单调（chunk=300s 远大于 2*search=16s），这里只做一次兜底裁剪
    ranges: list[tuple[int, int]] = []
    for index in range(len(bounds) - 1):
        start, end = bounds[index], bounds[index + 1]
        if end > start:
            ranges.append((start, end))
    return ranges


# --------------------------------------------------------------------------
# 转写
# --------------------------------------------------------------------------

def _transcribe_chunk(model, audio_slice: np.ndarray, language, offset_sec: float):
    """转写一块音频，返回 (词列表, 本块质量指标)。

    词列表为 [(绝对起始秒, 绝对结束秒, 词文本)]；
    质量指标含 avg_logprob / no_speech_prob / compression_ratio / 有效语音时长，
    供 P0-3 的异常短输出检测使用（详见 transcribe_audio）。
    """
    result = model.transcribe(
        audio_slice,
        language=language,
        task="transcribe",
        word_timestamps=True,
        condition_on_previous_text=False,   # 必须：否则音乐/静音处整段重复
        no_speech_threshold=NO_SPEECH_THRESHOLD,
        logprob_threshold=-1.0,
        compression_ratio_threshold=2.4,
        fp16=(DEVICE != "cpu"),
        # 注意：这里必须传 None 而不是 False。
        # whisper/transcribe.py 里是 `disable=verbose is not False` ——
        # 传 False 反而会**打开** tqdm 进度条，并打印 "Detected language:"；
        # 传 None 才是完全静默（不打印文本、不打印语种、不显示进度条）。
        # 进度由本模块按分块自行上报，不需要 whisper 自己再画一条。
        verbose=None,
    )
    return list(_words_of(result, offset_sec)), _chunk_metrics(result, offset_sec)


def _chunk_metrics(result: dict, offset_sec: float = 0.0) -> dict:
    """从 Whisper 的 segment 级结果聚合本块质量信号。"""
    segments = result.get("segments") or []
    if not segments:
        return {
            "mean_logprob": None,
            "max_no_speech": 0.0,
            "max_compression": 0.0,
            "speech_sec": 0.0,
            "language": result.get("language"),
            "language_prob": result.get("language_probability"),
        }

    logprobs = [s["avg_logprob"] for s in segments if s.get("avg_logprob") is not None]
    no_speech = [s["no_speech_prob"] for s in segments if s.get("no_speech_prob") is not None]
    comps = [s["compression_ratio"] for s in segments if s.get("compression_ratio") is not None]

    speech = 0.0
    for s in segments:
        if (s.get("no_speech_prob") or 0.0) < NO_SPEECH_THRESHOLD:
            start, end = s.get("start"), s.get("end")
            if start is not None and end is not None:
                speech += max(0.0, float(end) - float(start))

    return {
        "mean_logprob": (sum(logprobs) / len(logprobs)) if logprobs else None,
        "max_no_speech": max(no_speech) if no_speech else 0.0,
        "max_compression": max(comps) if comps else 0.0,
        "speech_sec": speech,
        "language": result.get("language"),
        "language_prob": result.get("language_probability"),
    }


def _words_of(result: dict, offset_sec: float = 0.0):
    """产出 (start, end, text)，时间为绝对秒。

    词级时间戳不可用时（极少见）退回 segment 级，避免整轨产出为空。
    """
    found = False
    for segment in result.get("segments") or []:
        for word in segment.get("words") or []:
            text = (word.get("word") or "").strip()
            if text:
                found = True
                yield offset_sec + float(word["start"]), offset_sec + float(word["end"]), text

    if found:
        return

    for segment in result.get("segments") or []:
        text = (segment.get("text") or "").strip()
        if text:
            yield offset_sec + float(segment["start"]), offset_sec + float(segment["end"]), text


# --------------------------------------------------------------------------
# 词级 -> 句级
# --------------------------------------------------------------------------

def _flush(buffer: list[str], start, end) -> dict | None:
    if not buffer or start is None or end is None:
        return None
    text = podcast_asr.join_words(buffer)
    if not text:
        return None
    return {"start": float(start), "end": float(end), "text": text}


def _split_to_sentences(words) -> list[dict]:
    """三个断点：句末标点 / 词间静音 >= WORD_GAP_SEC / 时长或字数到上限。"""
    rows: list[dict] = []
    buffer: list[str] = []
    buffer_start = None
    last_end = None

    for start, end, text in words:
        if buffer and last_end is not None and (start - last_end) >= WORD_GAP_SEC:
            row = _flush(buffer, buffer_start, last_end)
            if row:
                rows.append(row)
            buffer, buffer_start = [], None

        if buffer_start is None:
            buffer_start = start
        buffer.append(text)
        last_end = end

        joined = podcast_asr.join_words(buffer)
        if (
            podcast_asr.SENT_END_RE.search(joined)
            or (last_end - buffer_start) >= MAX_SEGMENT_SEC
            or len(joined) >= MAX_SEGMENT_CHARS
        ):
            row = _flush(buffer, buffer_start, last_end)
            if row:
                rows.append(row)
            buffer, buffer_start = [], None

    tail = _flush(buffer, buffer_start, last_end)
    if tail:
        rows.append(tail)
    return rows


def _dedupe_repeats(rows: list[dict]) -> list[dict]:
    """Whisper 在音乐/静音处会整行重复输出，这里合并相邻的完全相同行。"""
    out: list[dict] = []
    for row in rows:
        if out and row["text"] == out[-1]["text"]:
            out[-1]["end"] = row["end"]
            continue
        out.append(dict(row))
    return out


def _arbitrate(primary: list[dict], alt: list[dict]) -> list[dict]:
    """逐行裁决：取时间重叠最多的 alt 行，语种可判读强度更高者胜出。

    本项目语料是「英语讲解 + 法语示范」混排。单遍转写时，占主导的语种
    会把少数语种窗口硬转成自己的语言（实测 base 把法语压成英语音译）。
    双遍 + 逐行裁决等价于腾讯方案里的双引擎裁决。
    """
    out: list[dict] = []
    for row in primary:
        middle = (row["start"] + row["end"]) / 2.0
        best = None
        best_overlap = 0.0
        for candidate in alt:
            if candidate["start"] - 1.0 <= middle <= candidate["end"] + 1.0:
                overlap = min(candidate["end"], row["end"]) - max(candidate["start"], row["start"])
                if overlap > best_overlap:
                    best_overlap, best = overlap, candidate

        text = row["text"]
        if best is not None and (
            podcast_asr._language_confidence(best["text"])
            > podcast_asr._language_confidence(text) + 1
        ):
            text = best["text"]
        out.append({"start": row["start"], "end": row["end"], "text": text})
    return out


# --------------------------------------------------------------------------
# P0-3：异常短输出检测 + 条件重试
# --------------------------------------------------------------------------

def _aggregate_metrics(metrics_list: list[dict], audio_duration: float) -> dict:
    """跨块聚合，得到整集级别的质量信号。"""
    if not metrics_list:
        return {
            "mean_logprob": None,
            "max_no_speech": 0.0,
            "max_compression": 0.0,
            "coverage": 0.0,
            "language": None,
            "language_prob": None,
        }
    mean_logprobs = [m["mean_logprob"] for m in metrics_list if m["mean_logprob"] is not None]
    speech = sum(m["speech_sec"] for m in metrics_list)
    langs = [m["language"] for m in metrics_list if m["language"]]
    return {
        "mean_logprob": (sum(mean_logprobs) / len(mean_logprobs)) if mean_logprobs else None,
        "max_no_speech": max((m["max_no_speech"] for m in metrics_list), default=0.0),
        "max_compression": max((m["max_compression"] for m in metrics_list), default=0.0),
        "coverage": (speech / audio_duration) if audio_duration else 0.0,
        "language": langs[0] if langs else None,
        "language_prob": None,
    }


def assess_quality(metrics: dict, sentence_count: int, audio_total_sec: float):
    """返回 (是否异常, 原因列表)。

    判定独立于语种：既看 Whisper 自带的质量信号（置信度/静音/重复），
    也看"句数相对时长是否离谱"——后者正是 5401 类"塌缩成 1 句"的直接特征。
    不单看字数/分钟，避免把语速慢但正常的播客误杀。
    """
    reasons: list[str] = []
    if sentence_count <= 1 and audio_total_sec > ANOMALY_MIN_DURATION_SEC:
        reasons.append(f"句数过少({sentence_count}句/{audio_total_sec:.0f}s)")
    cov = metrics.get("coverage") or 0.0
    if audio_total_sec > 10 and cov < ANOMALY_MIN_COVERAGE:
        reasons.append(f"语音覆盖率过低({cov:.0%})")
    if metrics.get("max_no_speech", 0.0) > ANOMALY_MAX_NO_SPEECH:
        reasons.append(f"多段被判静音(no_speech={metrics['max_no_speech']:.2f})")
    lp = metrics.get("mean_logprob")
    if lp is not None and lp < ANOMALY_MIN_LOGPROB:
        reasons.append(f"置信度过低(avg_logprob={lp:.2f})")
    if metrics.get("max_compression", 0.0) > ANOMALY_MAX_COMPRESSION:
        reasons.append(f"重复循环(compression={metrics['max_compression']:.2f})")
    return bool(reasons), reasons


def _recovery_language(source_language: str, detected_language):
    """异常时切到哪个语种重试（只做一遍以控制耗时）。

    已知主坑：auto 把中文误判成 en，导致整集塌缩 1 句。
    因此 auto 下若检测语种不是 zh，则优先强制 zh；其余情形切到相反语种。
    """
    if source_language == "auto":
        return "zh" if (detected_language or "en") != "zh" else "en"
    if source_language in ("en", "zh_en"):
        return "zh"
    if source_language == "zh":
        return "en"
    if source_language == "fr":
        return "en"
    return None


def _quality_score(metrics: dict, sentence_count: int) -> float:
    """主/重试结果间择优用的分数，越高越好。"""
    cov = metrics.get("coverage") or 0.0
    lp = metrics.get("mean_logprob") or -5.0
    penalty = 0.0
    if metrics.get("max_no_speech", 0.0) > ANOMALY_MAX_NO_SPEECH:
        penalty += 1000.0
    if metrics.get("max_compression", 0.0) > ANOMALY_MAX_COMPRESSION:
        penalty += 1000.0
    return sentence_count * 10.0 + cov * 100.0 + max(0.0, lp + 1.5) * 50.0 - penalty


# --------------------------------------------------------------------------
# P0-2：auto 模式下多锚点语种预检
# --------------------------------------------------------------------------

def _detect_language_at(model, audio: "np.ndarray", start_sec: float):
    """在音频 start_sec 处取 30s 片段，返回 (语种码, 置信度)。

    直接复用 whisper 内部的检测配方（log_mel_spectrogram → pad_or_trim →
    detect_language），避免把整段音频喂进去白跑 encoder。
    """
    import torch
    import whisper
    from whisper.audio import N_FRAMES, N_SAMPLES

    sr = SAMPLE_RATE
    start = int(start_sec * sr)
    end = min(len(audio), start + 30 * sr)
    if end - start < int(1.0 * sr):
        return ("en", 0.0)
    segment = audio[start:end]
    try:
        mel = whisper.log_mel_spectrogram(segment, model.dims.n_mels, padding=N_SAMPLES)
        mel_segment = whisper.pad_or_trim(mel, N_FRAMES).to(model.device).to(torch.float32)
        _, probs = model.detect_language(mel_segment)
        language = max(probs, key=probs.get)
        return (language, float(probs[language]))
    except Exception as exc:  # noqa: BLE001
        print(f"[whisper] detect_language 预检失败（{exc}），回退 auto")
        return ("en", 0.0)


def _auto_detect_anchors(model, audio: "np.ndarray"):
    """auto 模式下在 头/中/尾 采样做语种预检，返回 [(语种, 置信度), ...]。"""
    total_sec = len(audio) / SAMPLE_RATE
    positions = [0.0]
    if total_sec > 60:
        positions.append(total_sec * 0.5)
    if total_sec > 120:
        positions.append(max(0.0, total_sec - 30))
    return [_detect_language_at(model, audio, p) for p in positions]


def _select_language_from_anchors(anchors, zh_min_prob=None, other_min_prob=None):
    """多锚点投票决定 auto 的强制语种（P1，泛化自 P0-2 的中文预检）。

    中文优先（已知误判重灾区）：任一锚点中文置信度达标即强制 zh。
    否则只在「fr/en 锚点」子集内投票：若该子集一致地指向同一语种且都高置信，
    则强制该语种，覆盖 whisper 首 30s 的偶发误判。注意只统计 fr/en 锚点——
    混入的低置信 zh/其他语种锚点（如中文标题、口误）不应阻断对明显 fr/en 播客的强制，
    否则 P1 对「开头语种被误判」的播客反而会失效。其余情况回退 None（走 whisper 原生 auto）。
    """
    if zh_min_prob is None:
        zh_min_prob = AUTO_ZH_MIN_PROB
    if other_min_prob is None:
        other_min_prob = AUTO_OTHER_MIN_PROB
    if not anchors:
        return None
    if any(lang == "zh" and prob >= zh_min_prob for lang, prob in anchors):
        return "zh"
    # 仅 fr/en 锚点参与「一致强制」投票，避免杂锚点（中文标题/口误）阻断
    fr_en = [(lang, prob) for lang, prob in anchors if lang in ("fr", "en")]
    if not fr_en:
        return None
    langs = {lang for lang, _ in fr_en}
    if len(langs) == 1:
        lang = next(iter(langs))
        if all(prob >= other_min_prob for _, prob in fr_en):
            return lang
    return None


# --------------------------------------------------------------------------
# 对外入口（与 podcast_asr.transcribe_audio 契约一致）
# --------------------------------------------------------------------------

def transcribe_audio(
    path: str,
    asr=None,
    source_language: str = "auto",
    on_progress=None,
    on_retry=None,
    **_ignored,
) -> list[dict]:
    """返回 [{start, end, text}]，start/end 为秒。

    P0-3：转写完成后做异常短输出检测。若判定异常（整集塌缩成 1 句、整段被判静音、
    置信度过低、重复循环），且存在可重试语种，则换语种重跑一遍；重试仍异常则抛错，
    绝不让"看起来成功但只有 1 句"的结果入库。
    """
    model = asr if asr is not None else get_model()
    audio = _load_audio_f32(path)
    ranges = _chunk_ranges(audio)
    if not ranges:
        raise podcast_asr.ASRError("音频解码后长度为 0")

    # 固定语种只跑一遍；auto + 双语裁决跑两遍，因此进度总量按遍数预分配
    # 选语种改造 P0-1：zh / zh_en 强制以中文解码（Whisper 无 zh_en，统一按 zh）；
    # 其余（auto / fr / en）保持原行为
    FORCED_WHISPER_LANG = {"fr": "fr", "en": "en", "zh": "zh", "zh_en": "zh"}
    language = FORCED_WHISPER_LANG.get(source_language)
    passes = 2 if (language is None and BILINGUAL) else 1

    # P0-2 + P1：auto 下多锚点预检，判定主语种后提前强制（中文优先，fr/en 全一致才强制），
    # 省去 P0-3 的 2x 重试开销；P0-3 仍作兜底。
    if language is None and WHISPER_AUTO_ZH_FALLBACK:
        anchors = _auto_detect_anchors(model, audio)
        forced = _select_language_from_anchors(anchors, zh_min_prob=AUTO_ZH_MIN_PROB)
        if forced:
            print(f"[whisper] auto 多锚点预检判定为 {forced}（{anchors}），强制转写")
            language = forced
            passes = 1

    total_units = max(1, len(ranges) * passes)
    units = 0

    def run(forced_language, report: bool = True):
        nonlocal units
        words: list[tuple[float, float, str]] = []
        metrics_list: list[dict] = []
        for start_sample, end_sample in ranges:
            offset = start_sample / SAMPLE_RATE
            chunk_words, chunk_metrics = _transcribe_chunk(
                model, audio[start_sample:end_sample], forced_language, offset
            )
            words.extend(chunk_words)
            metrics_list.append(chunk_metrics)
            units += 1
            if report and on_progress:
                on_progress(units, total_units)
        return _split_to_sentences(words), _aggregate_metrics(
            metrics_list, audio_duration=len(audio) / SAMPLE_RATE
        )

    rows, metrics = run(language)

    if language is None and BILINGUAL and rows:
        sample = " ".join(row["text"] for row in rows[:30])
        other = "en" if podcast_asr.detect_text_language(sample) == "fr" else "fr"
        alt_rows, _ = run(other)
        rows = _arbitrate(rows, alt_rows)

    rows = _dedupe_repeats(rows)
    if not rows:
        raise podcast_asr.ASRError("Whisper 未产出任何文本段（音频可能全为静音）")

    # ── P0-3：异常短输出检测 + 条件重试 ──
    audio_total_sec = len(audio) / SAMPLE_RATE
    anomalous, reasons = assess_quality(metrics, len(rows), audio_total_sec)
    if anomalous:
        if ANOMALY_RETRY_ENABLED:
            recovery = _recovery_language(source_language, metrics.get("language"))
            if recovery and recovery != language:
                if on_retry:
                    on_retry(recovery)
                rec_rows, rec_metrics = run(recovery, report=False)
                rec_rows = _dedupe_repeats(rec_rows)
                rec_anom, rec_reasons = assess_quality(
                    rec_metrics, len(rec_rows), audio_total_sec
                )
                print(
                    f"[whisper] 重试({recovery})：{len(rec_rows)} 行，"
                    f"异常={rec_anom}（{rec_reasons}）"
                )
                if not rec_anom:
                    rows = rec_rows
                elif _quality_score(rec_metrics, len(rec_rows)) > _quality_score(metrics, len(rows)):
                    rows = rec_rows
                else:
                    raise podcast_asr.ASRError(
                        f"转写质量异常且重试未改善：主因 {reasons}；"
                        f"重试({recovery}) {rec_reasons}"
                    )
            else:
                raise podcast_asr.ASRError(f"转写质量异常且无可重试语种：{reasons}")
        else:
            raise podcast_asr.ASRError(f"转写质量异常：{reasons}")

    return rows
