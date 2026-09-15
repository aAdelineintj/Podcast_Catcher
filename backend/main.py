import hashlib
import html
import json
import os
import random
import re
import shutil
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from glob import glob

import requests
from dotenv import load_dotenv
from pydantic import BaseModel, HttpUrl
from fastapi import APIRouter, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import podcast_asr

# 仓库根目录（backend/ 的上一级）。配置与数据都以仓库根为基准，避免受启动工作目录影响。
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 先读仓库根的 .env，再读当前工作目录的 .env（不覆盖已有值）
load_dotenv(os.path.join(_REPO_ROOT, ".env"))
load_dotenv()

app = FastAPI()
router = APIRouter()

_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# PocketBay 会挂载持久卷并注入 POCKETBAY_DATA_DIR=/data；本地开发回落到 <仓库根>/data
DATA_ROOT = os.getenv("POCKETBAY_DATA_DIR") or os.path.join(_REPO_ROOT, "data")
INPUT_DIR = os.path.join(DATA_ROOT, "input")
OUTPUT_DIR = os.path.join(DATA_ROOT, "output")
# 任务元数据落盘目录：进程重启后据此恢复任务，避免「查询 404 → 前端静默停摆」
JOB_STATE_DIR = os.path.join(DATA_ROOT, "jobs")
os.makedirs(INPUT_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(JOB_STATE_DIR, exist_ok=True)

app.mount("/media", StaticFiles(directory=INPUT_DIR, check_dir=False), name="media")

BAIDU_APP_ID = os.getenv("BAIDU_APP_ID") or os.getenv("APP_ID")
BAIDU_SECRET_KEY = os.getenv("BAIDU_SECRET_KEY") or os.getenv("SECRET_KEY")

TENCENT_SECRET_ID = os.getenv("TENCENT_SECRET_ID") or os.getenv("TENCENTCLOUD_SECRET_ID")
TENCENT_SECRET_KEY = os.getenv("TENCENT_SECRET_KEY") or os.getenv("TENCENTCLOUD_SECRET_KEY")
TENCENT_REGION = os.getenv("TENCENT_REGION", "ap-shanghai")
ASR_MAX_WORKERS = int(os.getenv("ASR_MAX_WORKERS", "16"))
# 时间戳小数位：0 = "M:SS"（与历史行为一致）；1 = "M:SS.s"（更高精度）
TIMESTAMP_DECIMALS = int(os.getenv("TIMESTAMP_DECIMALS", "0"))

FRENCH_HINTS = {
    "bonjour", "merci", "maintenant", "nous", "vous", "avec", "pour", "dans",
    "une", "des", "les", "est", "etre", "suis", "sommes", "avez", "fait",
    "tres", "plus", "bien", "mais", "parce", "comme", "quand", "quel",
    "quelle", "ce", "cet", "cette", "ces", "qui", "que", "quoi", "dont",
    "mon", "ton", "son", "notre", "votre", "leur", "oui", "non", "pas",
}

ENGLISH_HINTS = {
    "the", "and", "is", "are", "was", "were", "have", "has", "do", "does",
    "did", "with", "for", "from", "that", "this", "these", "those", "what",
    "when", "where", "why", "how", "hello", "thanks", "thank", "please",
    "now", "more", "little", "talk", "about", "your", "my", "our", "their",
    "not", "yes", "no", "welcome", "learn", "podcast",
}

SOURCE_LANGUAGE_ALIASES = {
    "auto": "auto",
    "detect": "auto",
    "detected": "auto",
    "fr": "fr",
    "fra": "fr",
    "fre": "fr",
    "french": "fr",
    "法语": "fr",
    "en": "en",
    "eng": "en",
    "english": "en",
    "英语": "en",
}

BAIDU_LANGUAGE_BY_SOURCE = {
    "auto": "auto",
    "fr": "fra",
    "en": "en",
}

# 腾讯云一句话识别引擎（本项目只用单语种引擎：法语 / 英语）
TENCENT_ENGINE_BY_SOURCE = {
    "fr": "16k_fr",
    "en": "16k_en",
}

_asr_client: podcast_asr.TencentSentenceASR | None = None
_asr_lock = threading.Lock()


def get_asr_client() -> podcast_asr.TencentSentenceASR:
    """延迟初始化：缺少密钥时应用仍能启动，只有跑任务时才报错。"""
    global _asr_client
    if _asr_client is None:
        with _asr_lock:
            if _asr_client is None:
                _asr_client = podcast_asr.TencentSentenceASR(
                    TENCENT_SECRET_ID,
                    TENCENT_SECRET_KEY,
                    region=TENCENT_REGION,
                    max_workers=ASR_MAX_WORKERS,
                )
    return _asr_client


jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()

# 需要落盘的任务元数据字段。segments 体积大，单独写进 OUTPUT_DIR 的结果文件，不在这里重复存。
_JOB_STATE_FIELDS = (
    "job_id", "status", "stage", "filename", "source_language",
    "transcription_language", "progress", "translated_count",
    "total_segments", "error",
)


def job_state_path(job_id: str) -> str:
    return os.path.join(JOB_STATE_DIR, f"{job_id}.json")


def persist_job(job_id: str) -> None:
    """把任务元数据写盘（原子替换）。落盘失败不影响主流程。"""
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return
        snapshot = {key: job.get(key) for key in _JOB_STATE_FIELDS}

    path = job_state_path(job_id)
    try:
        with open(f"{path}.tmp", "w", encoding="utf-8") as file_obj:
            json.dump(snapshot, file_obj, ensure_ascii=False, indent=2)
        os.replace(f"{path}.tmp", path)
    except OSError as exc:
        print(f"[{job_id}] 任务状态落盘失败: {exc}")


def write_result_file(job_id: str, segments: list[dict]) -> str:
    """把当前已得到的字幕写进 OUTPUT_DIR（原子替换）。

    转录一完成就调用一次，这样即便后续翻译阶段挂掉或进程重启，
    已经转出来的原文也不会丢。
    """
    result_path = os.path.join(OUTPUT_DIR, f"{job_id}.json")
    with open(f"{result_path}.tmp", "w", encoding="utf-8") as file_obj:
        json.dump(segments, file_obj, ensure_ascii=False, indent=2)
    os.replace(f"{result_path}.tmp", result_path)
    return result_path


def load_persisted_jobs() -> int:
    """启动时回灌历史任务。

    没有这一步时：进程一重启，GET /jobs/{id} 就返回 404，前端轮询静默停摆，
    用户只能看到「一直卡在处理中」，完全不知道发生了什么。
    """
    restored = 0
    for state_path in sorted(glob(os.path.join(JOB_STATE_DIR, "*.json"))):
        try:
            with open(state_path, "r", encoding="utf-8") as file_obj:
                meta = json.load(file_obj)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[jobs] 跳过损坏的任务状态文件 {state_path}: {exc}")
            continue

        job_id = str(meta.get("job_id") or os.path.splitext(os.path.basename(state_path))[0])
        result_path = os.path.join(OUTPUT_DIR, f"{job_id}.json")

        segments: list[dict] = []
        if os.path.exists(result_path):
            try:
                with open(result_path, "r", encoding="utf-8") as file_obj:
                    loaded = json.load(file_obj)
                if isinstance(loaded, list):
                    segments = loaded
            except (OSError, json.JSONDecodeError) as exc:
                print(f"[{job_id}] 结果文件解析失败: {exc}")

        status = str(meta.get("status") or "unknown")
        stage = str(meta.get("stage") or "unknown")
        error = meta.get("error")

        # 落盘状态仍是「排队中/处理中」，说明上次是被强制中断的（进程重启）。
        # 必须显式转成 failed 并写明原因，否则前端会一直等一个不会到来的结果。
        if status in {"queued", "processing"}:
            status, stage = "failed", "failed"
            error = "任务在后端进程重启时中断，结果未生成，请重新上传该音频。"

        with jobs_lock:
            jobs[job_id] = {
                "job_id": job_id,
                "status": status,
                "stage": stage,
                "filename": meta.get("filename") or job_id,
                "source_language": normalize_source_language(meta.get("source_language")),
                "transcription_language": meta.get("transcription_language"),
                "progress": int(meta.get("progress") or 0),
                "translated_count": int(meta.get("translated_count") or 0),
                "total_segments": int(meta.get("total_segments") or len(segments)),
                "error": error,
                "segments": segments,
                "input_path": resolve_job_media_path(job_id),
                "output_path": result_path if segments else None,
            }
        restored += 1

    return restored

DEFAULT_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,"
        "image/apng,*/*;q=0.8"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}


class RSSParseRequest(BaseModel):
    rss_url: HttpUrl


class RSSProcessItemRequest(BaseModel):
    rss_url: HttpUrl
    audio_url: HttpUrl
    title: str
    published_at: str | None = None
    source_language: str = "auto"


def normalize_source_language(value: str | None) -> str:
    normalized = (value or "auto").strip().lower()
    return SOURCE_LANGUAGE_ALIASES.get(normalized, "auto")


def baidu_language_for_source(source_language: str) -> str:
    return BAIDU_LANGUAGE_BY_SOURCE.get(normalize_source_language(source_language), "auto")


def baidu_translate(text, from_lang="auto", to_lang="zh"):
    if not BAIDU_APP_ID or not BAIDU_SECRET_KEY:
        return "Translation Error: API keys missing"

    url = "http://api.fanyi.baidu.com/api/trans/vip/translate"
    salt = str(random.randint(32768, 65536))
    sign_str = BAIDU_APP_ID + text + salt + BAIDU_SECRET_KEY
    sign = hashlib.md5(sign_str.encode("utf-8")).hexdigest()

    params = {
        "q": text,
        "from": from_lang,
        "to": to_lang,
        "appid": BAIDU_APP_ID,
        "salt": salt,
        "sign": sign,
    }

    try:
        response = requests.get(url, params=params, timeout=10)
        result = response.json()
        if "trans_result" in result:
            return result["trans_result"][0]["dst"]
        return f"Error: {result.get('error_msg', 'Unknown error')}"
    except Exception as exc:
        return f"Network Error: {str(exc)}"


def normalize_tokens(text: str) -> list[str]:
    return re.findall(r"[a-zA-ZÀ-ÿ']+", text.lower())


def detect_segment_language(text: str) -> tuple[str, str]:
    tokens = normalize_tokens(text)
    normalized_text = f" {' '.join(tokens)} "

    if not tokens:
        return "auto", "empty_text"

    if re.search(r"[àâçéèêëîïôùûüÿœæ]", text.lower()):
        return "fra", "accent_chars"

    french_score = 0
    english_score = 0

    for token in tokens:
        stripped = token.strip("'")
        if stripped in FRENCH_HINTS:
            french_score += 2
        if stripped in ENGLISH_HINTS:
            english_score += 2

    for pattern in [" je ", " ne ", " pas ", " vous ", " nous ", " qu'", " j'", " c'"]:
        if pattern in normalized_text:
            french_score += 1

    for pattern in [" the ", " and ", " you ", " are ", " is ", " i'm ", " we're "]:
        if pattern in normalized_text:
            english_score += 1

    if french_score == 0 and english_score == 0:
        return "auto", "no_clear_signal"
    if french_score > english_score:
        return "fra", f"french_score:{french_score}"
    if english_score > french_score:
        return "en", f"english_score:{english_score}"
    return "auto", f"tie:{french_score}"


def format_timestamp(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    minutes = int(seconds // 60)
    remaining = seconds - minutes * 60
    if TIMESTAMP_DECIMALS > 0:
        return f"{minutes}:{remaining:0{3 + TIMESTAMP_DECIMALS}.{TIMESTAMP_DECIMALS}f}"
    return f"{minutes}:{int(remaining):02d}"


def build_progress_snapshot(job_id: str) -> dict:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        segments = [dict(segment) for segment in job["segments"]]
        media_filename = os.path.basename(job["input_path"]) if job.get("input_path") else None
        return {
            "job_id": job_id,
            "status": job["status"],
            "stage": job["stage"],
            "filename": job["filename"],
            "source_language": job.get("source_language", "auto"),
            "transcription_language": job.get("transcription_language"),
            "media_url": f"/media/{media_filename}" if media_filename else None,
            "progress": job["progress"],
            "translated_count": job["translated_count"],
            "total_segments": job["total_segments"],
            "error": job["error"],
            "segments": segments,
        }


def resolve_job_media_path(job_id: str) -> str | None:
    matches = sorted(glob(os.path.join(INPUT_DIR, f"{job_id}.*")))
    return matches[0] if matches else None


def update_job(job_id: str, **changes):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(changes)
    persist_job(job_id)


def create_job_record(job_id: str, filename: str, input_path: str, source_language: str = "auto"):
    normalized_source_language = normalize_source_language(source_language)
    with jobs_lock:
        jobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "stage": "uploaded",
            "filename": filename,
            "source_language": normalized_source_language,
            "transcription_language": None,
            "progress": 0,
            "translated_count": 0,
            "total_segments": 0,
            "error": None,
            "segments": [],
            "input_path": input_path,
            "output_path": None,
        }
    persist_job(job_id)


def queue_processing_job(job_id: str, input_path: str, source_language: str = "auto"):
    worker = threading.Thread(
        target=process_job,
        args=(job_id, input_path, source_language),
        daemon=True,
    )
    worker.start()


def safe_audio_extension(url: str) -> str:
    match = re.search(r"\.(mp3|m4a|aac|wav|ogg)(?:\?|$)", url.lower())
    if match:
        return f".{match.group(1)}"
    return ".mp3"


def namespace_map(root: ET.Element) -> dict[str, str]:
    namespaces = {"atom": "http://www.w3.org/2005/Atom"}
    if root.tag.startswith("{"):
        namespaces["default"] = root.tag.split("}")[0].strip("{")
    return namespaces


def text_or_empty(element: ET.Element | None) -> str:
    if element is None or element.text is None:
        return ""
    return element.text.strip()


def fetch_with_retry(url: str, *, headers: dict | None = None, stream: bool = False, timeout: int = 20):
    merged_headers = dict(DEFAULT_BROWSER_HEADERS)
    if headers:
      merged_headers.update(headers)

    last_error = None
    retry_delays = [0.8, 1.5, 2.5]
    for attempt, delay in enumerate(retry_delays, start=1):
        try:
            response = requests.get(url, headers=merged_headers, stream=stream, timeout=timeout)
            if response.status_code in {429, 500, 502, 503, 504} and attempt < len(retry_delays):
                response.close()
                time.sleep(delay)
                continue
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            last_error = exc
            if attempt < len(retry_delays):
                time.sleep(delay)
                continue
            raise

    if last_error is not None:
        raise last_error
    raise RuntimeError("Request failed without a captured exception")


def is_xiaoyuzhou_episode_url(url: str) -> bool:
    return "xiaoyuzhoufm.com/episode/" in url


def extract_first_match(patterns: list[str], text: str) -> str:
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
        if match:
            return html.unescape(match.group(1).strip())
    return ""


def search_audio_url_in_json(value) -> str:
    if isinstance(value, dict):
        for item in value.values():
            audio_url = search_audio_url_in_json(item)
            if audio_url:
                return audio_url
    elif isinstance(value, list):
        for item in value:
            audio_url = search_audio_url_in_json(item)
            if audio_url:
                return audio_url
    elif isinstance(value, str):
        if re.search(r"https?://[^\s\"']+\.(mp3|m4a|aac|wav|ogg)(?:\?|$)", value, re.IGNORECASE):
            return value
    return ""


def parse_xiaoyuzhou_episode(url: str) -> list[dict]:
    response = fetch_with_retry(
        url,
        timeout=20,
        headers={
            "Referer": "https://www.xiaoyuzhoufm.com/",
            "Upgrade-Insecure-Requests": "1",
        },
    )
    html_text = response.text

    title = extract_first_match(
        [
            r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"',
            r"<title>([^<]+)</title>",
        ],
        html_text,
    )
    published_at = extract_first_match(
        [
            r'<meta[^>]+property="article:published_time"[^>]+content="([^"]+)"',
            r'"pubDate":"([^"]+)"',
            r'"publishedAt":"([^"]+)"',
        ],
        html_text,
    )
    description = extract_first_match(
        [
            r'<meta[^>]+name="description"[^>]+content="([^"]+)"',
            r'<meta[^>]+property="og:description"[^>]+content="([^"]+)"',
        ],
        html_text,
    )

    audio_url = extract_first_match(
        [
            r'<meta[^>]+property="og:audio"[^>]+content="([^"]+)"',
            r'"audio(?:U|u)rl":"([^"]+)"',
            r'"audioSrc":"([^"]+)"',
            r'"media(?:U|u)rl":"([^"]+)"',
            r'"sourceUrl":"([^"]+?\.(?:mp3|m4a|aac|wav|ogg)[^"]*)"',
            r'https?:\/\/[^"\']+\.(?:mp3|m4a|aac|wav|ogg)(?:\?[^"\']*)?',
        ],
        html_text,
    )

    if not audio_url:
        next_data_match = re.search(
            r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>',
            html_text,
            re.IGNORECASE | re.DOTALL,
        )
        if next_data_match:
            try:
                next_data = json.loads(next_data_match.group(1))
                audio_url = search_audio_url_in_json(next_data)
            except json.JSONDecodeError:
                audio_url = ""

    if not audio_url:
        json_blobs = re.findall(
            r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>',
            html_text,
            re.IGNORECASE | re.DOTALL,
        )
        for blob in json_blobs:
            try:
                data = json.loads(blob)
                audio_url = search_audio_url_in_json(data)
                if audio_url:
                    break
            except json.JSONDecodeError:
                continue

    if not audio_url:
        raise ValueError("没有在小宇宙单集页面中找到音频地址。")

    cleaned_title = re.sub(r"\s*\|\s*小宇宙.*$", "", title).strip() or "Xiaoyuzhou episode"
    return [{
        "title": cleaned_title,
        "audio_url": audio_url,
        "published_at": published_at,
        "description": description,
    }]


def parse_rss_feed(rss_url: str) -> list[dict]:
    response = fetch_with_retry(rss_url, timeout=20)
    root = ET.fromstring(response.content)
    namespaces = namespace_map(root)

    items: list[dict] = []
    rss_items = root.findall(".//item")
    atom_entries = root.findall(".//atom:entry", namespaces)

    if rss_items:
        for item in rss_items:
            enclosure = item.find("enclosure")
            audio_url = enclosure.attrib.get("url", "").strip() if enclosure is not None else ""
            if not audio_url:
                continue
            items.append({
                "title": text_or_empty(item.find("title")) or "Untitled episode",
                "audio_url": audio_url,
                "published_at": text_or_empty(item.find("pubDate")),
                "description": text_or_empty(item.find("description")),
            })
    elif atom_entries:
        for entry in atom_entries:
            audio_url = ""
            for link in entry.findall("atom:link", namespaces):
                rel = link.attrib.get("rel", "")
                link_type = link.attrib.get("type", "")
                href = link.attrib.get("href", "").strip()
                if href and ("audio" in link_type or rel == "enclosure"):
                    audio_url = href
                    break
            if not audio_url:
                continue
            items.append({
                "title": text_or_empty(entry.find("atom:title", namespaces)) or "Untitled episode",
                "audio_url": audio_url,
                "published_at": text_or_empty(entry.find("atom:updated", namespaces)),
                "description": text_or_empty(entry.find("atom:summary", namespaces)),
            })

    return items[:20]


def download_audio_to_input(job_id: str, audio_url: str) -> str:
    input_path = os.path.join(INPUT_DIR, f"{job_id}{safe_audio_extension(audio_url)}")
    with fetch_with_retry(
        audio_url,
        stream=True,
        timeout=60,
        headers={"Referer": "https://www.xiaoyuzhoufm.com/"},
    ) as response:
        with open(input_path, "wb") as output_file:
            for chunk in response.iter_content(chunk_size=1024 * 512):
                if chunk:
                    output_file.write(chunk)
    return input_path


def process_job(job_id: str, input_path: str, source_language: str = "auto"):
    segments: list[dict] = []
    try:
        source_language = normalize_source_language(source_language)

        update_job(job_id, status="processing", stage="transcribing", progress=5)
        print(f"[{job_id}] 1. File saved: {input_path}")
        print(
            f"[{job_id}] 2. Transcribing (local VAD + Tencent SentenceRecognition): "
            f"{jobs[job_id]['filename']} (source_language={source_language})"
        )

        asr = get_asr_client()

        def on_progress(done: int, total: int) -> None:
            progress = 5 + int((done / max(total, 1)) * 15)
            update_job(job_id, stage="transcribing", progress=min(progress, 20))

        rows = podcast_asr.transcribe_audio(
            input_path,
            asr,
            source_language=source_language,
            on_progress=on_progress,
        )

        if source_language == "auto":
            sample = " ".join(row["text"] for row in rows[:40])
            transcription_language = podcast_asr.detect_text_language(sample)
        else:
            transcription_language = source_language
        update_job(job_id, transcription_language=transcription_language)
        print(
            f"[{job_id}] 3. Transcription finished: {len(rows)} rows, "
            f"language={transcription_language}"
        )

        segments = []
        for row in rows:
            original_text = str(row.get("text", "")).strip()
            if not original_text:
                continue

            if source_language == "auto":
                detected_lang, detection_reason = detect_segment_language(original_text)
                if detected_lang == "auto":
                    fallback = baidu_language_for_source(transcription_language)
                    if fallback != "auto":
                        detected_lang = fallback
                        detection_reason = f"asr_audio_language:{transcription_language}"
            else:
                detected_lang = baidu_language_for_source(source_language)
                detection_reason = "forced_source_language"

            segments.append({
                "start": format_timestamp(float(row.get("start", 0.0))),
                "original": original_text,
                "detected_lang": detected_lang,
                "detection_reason": detection_reason,
                "translation": "",
                "translation_status": "pending",
            })

        update_job(
            job_id,
            stage="transcribed",
            progress=20,
            total_segments=len(segments),
            segments=segments,
        )

        # 转录一完成就先落一版盘：即便后续翻译阶段挂掉或进程重启，
        # 已经转出来的原文也不会丢。
        write_result_file(job_id, segments)

        print(f"[{job_id}] 4. Translating {len(segments)} segments...")
        total_segments = max(len(segments), 1)

        for index, segment in enumerate(segments):
            if not segment["original"]:
                segment["translation_status"] = "skipped"
            else:
                print(
                    f"[{job_id}]    - [{index + 1}/{len(segments)}] "
                    f"lang={segment['detected_lang']} text={segment['original'][:40]}"
                )
                segment["translation"] = baidu_translate(
                    segment["original"],
                    from_lang=segment["detected_lang"],
                )
                segment["translation_status"] = "done"
                time.sleep(1.0)

            progress = 20 + int(((index + 1) / total_segments) * 75)
            update_job(
                job_id,
                stage="translating",
                progress=min(progress, 95),
                translated_count=index + 1,
                segments=segments,
            )

            # 每 20 句刷一次盘，中断时也能保住大部分已翻译内容
            if (index + 1) % 20 == 0:
                write_result_file(job_id, segments)

        result_path = write_result_file(job_id, segments)

        update_job(
            job_id,
            status="success",
            stage="completed",
            progress=100,
            translated_count=len(segments),
            output_path=result_path,
        )
        print(f"[{job_id}] 5. Output saved: {result_path}")
    except Exception as exc:
        update_job(
            job_id,
            status="failed",
            stage="failed",
            error=str(exc),
        )
        # 失败时也把已经拿到的部分结果落盘，避免用户「什么都看不到」
        if segments:
            try:
                partial_path = write_result_file(job_id, segments)
                update_job(job_id, output_path=partial_path, total_segments=len(segments))
                print(f"[{job_id}] 已保留部分结果: {len(segments)} 段")
            except OSError as write_exc:
                print(f"[{job_id}] 部分结果落盘失败: {write_exc}")
        print(f"[{job_id}] Error processing file: {str(exc)}")


@router.post("/process-podcast")
async def process_podcast(
    file: UploadFile = File(...),
    source_language: str = Form("auto"),
):
    job_id = str(uuid.uuid4())
    filename = file.filename or "audio.mp3"
    _, file_ext = os.path.splitext(filename)
    input_path = os.path.join(INPUT_DIR, f"{job_id}{file_ext}")
    normalized_source_language = normalize_source_language(source_language)

    with open(input_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    create_job_record(job_id, filename, input_path, normalized_source_language)
    queue_processing_job(job_id, input_path, normalized_source_language)

    return {
        "job_id": job_id,
        "status": "queued",
        "filename": filename,
        "source_language": normalized_source_language,
    }


@router.post("/parse-rss")
async def parse_rss(request: RSSParseRequest):
    try:
        source_url = str(request.rss_url)
        if is_xiaoyuzhou_episode_url(source_url):
            items = parse_xiaoyuzhou_episode(source_url)
        else:
            items = parse_rss_feed(source_url)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"链接解析失败: {str(exc)}") from exc

    if not items:
        raise HTTPException(status_code=404, detail="没有从该链接中找到可用的音频条目。")

    return {
        "rss_url": str(request.rss_url),
        "items": items,
    }


@router.post("/process-rss-item")
async def process_rss_item(request: RSSProcessItemRequest):
    job_id = str(uuid.uuid4())
    title = request.title.strip() or "RSS episode"
    source_language = normalize_source_language(request.source_language)

    try:
        input_path = download_audio_to_input(job_id, str(request.audio_url))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"音频下载失败: {str(exc)}") from exc

    create_job_record(job_id, title, input_path, source_language)
    update_job(job_id, stage="downloaded", progress=2)
    queue_processing_job(job_id, input_path, source_language)

    return {
        "job_id": job_id,
        "status": "queued",
        "filename": title,
        "published_at": request.published_at,
        "rss_url": str(request.rss_url),
        "source_language": source_language,
    }


@router.get("/jobs/{job_id}")
async def get_job_status(job_id: str):
    return build_progress_snapshot(job_id)


@router.get("/jobs/{job_id}/media")
async def get_job_media(job_id: str):
    media_path = resolve_job_media_path(job_id)
    if not media_path:
        raise HTTPException(status_code=404, detail="Media not found")
    return FileResponse(media_path)


@router.get("/health")
async def health_check():
    return {"status": "ok", "jobs": len(jobs)}


# 同时挂到 /api/* 与根路径：/api 是通用约定，根路径兼容既有前端调用。
app.include_router(router, prefix="/api")
app.include_router(router)

# 启动即回灌历史任务。没有这一步，进程重启后 GET /jobs/{id} 会返回 404，
# 前端轮询静默停摆，用户只能看到「一直卡在处理中」。
_restored_jobs = load_persisted_jobs()
print(f"[jobs] 已恢复 {_restored_jobs} 个历史任务（状态目录 {JOB_STATE_DIR}）")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
