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

import requests
import whisper
from dotenv import load_dotenv
from pydantic import BaseModel, HttpUrl
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/media", StaticFiles(directory="data/input"), name="media")

INPUT_DIR = "data/input"
OUTPUT_DIR = "data/output"
os.makedirs(INPUT_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

BAIDU_APP_ID = os.getenv("BAIDU_APP_ID") or os.getenv("APP_ID")
BAIDU_SECRET_KEY = os.getenv("BAIDU_SECRET_KEY") or os.getenv("SECRET_KEY")

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

print("Loading Whisper model (base)...")
model = whisper.load_model("base")

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()

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
    minutes = int(seconds // 60)
    remaining_seconds = int(seconds % 60)
    return f"{minutes}:{remaining_seconds:02d}"


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
            "media_url": f"http://localhost:8000/media/{media_filename}" if media_filename else None,
            "progress": job["progress"],
            "translated_count": job["translated_count"],
            "total_segments": job["total_segments"],
            "error": job["error"],
            "segments": segments,
        }


def update_job(job_id: str, **changes):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(changes)


def create_job_record(job_id: str, filename: str, input_path: str):
    with jobs_lock:
        jobs[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "stage": "uploaded",
            "filename": filename,
            "progress": 0,
            "translated_count": 0,
            "total_segments": 0,
            "error": None,
            "segments": [],
            "input_path": input_path,
            "output_path": None,
        }


def queue_processing_job(job_id: str, input_path: str):
    worker = threading.Thread(
        target=process_job,
        args=(job_id, input_path),
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


def process_job(job_id: str, input_path: str):
    try:
        update_job(job_id, status="processing", stage="transcribing", progress=5)
        print(f"[{job_id}] 1. File saved: {input_path}")
        print(f"[{job_id}] 2. Transcribing: {jobs[job_id]['filename']}")
        result = model.transcribe(input_path)
        print(f"[{job_id}] 3. Transcription finished")

        raw_segments = result.get("segments", [])
        segments = []
        for seg in raw_segments:
            if isinstance(seg, dict):
                original_text = str(seg.get("text", "")).strip()
                detected_lang, detection_reason = detect_segment_language(original_text)
                segments.append({
                    "start": format_timestamp(float(seg.get("start", 0.0))),
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

        result_path = os.path.join(OUTPUT_DIR, f"{job_id}.json")
        with open(result_path, "w", encoding="utf-8") as file_obj:
            json.dump(segments, file_obj, ensure_ascii=False, indent=2)

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
        print(f"[{job_id}] Error processing file: {str(exc)}")


@app.post("/process-podcast")
async def process_podcast(file: UploadFile = File(...)):
    job_id = str(uuid.uuid4())
    filename = file.filename or "audio.mp3"
    _, file_ext = os.path.splitext(filename)
    input_path = os.path.join(INPUT_DIR, f"{job_id}{file_ext}")

    with open(input_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    create_job_record(job_id, filename, input_path)
    queue_processing_job(job_id, input_path)

    return {
        "job_id": job_id,
        "status": "queued",
        "filename": filename,
    }


@app.post("/parse-rss")
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


@app.post("/process-rss-item")
async def process_rss_item(request: RSSProcessItemRequest):
    job_id = str(uuid.uuid4())
    title = request.title.strip() or "RSS episode"

    try:
        input_path = download_audio_to_input(job_id, str(request.audio_url))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"音频下载失败: {str(exc)}") from exc

    create_job_record(job_id, title, input_path)
    update_job(job_id, stage="downloaded", progress=2)
    queue_processing_job(job_id, input_path)

    return {
        "job_id": job_id,
        "status": "queued",
        "filename": title,
        "published_at": request.published_at,
        "rss_url": str(request.rss_url),
    }


@app.get("/jobs/{job_id}")
async def get_job_status(job_id: str):
    return build_progress_snapshot(job_id)


@app.get("/health")
async def health_check():
    return {"status": "ok", "jobs": len(jobs)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
