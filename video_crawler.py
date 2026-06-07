"""
视频爬虫脚本 - 可爬取网页中的视频并下载
用法: python video_crawler.py <url> [选项]

依赖安装: pip install requests beautifulsoup4 yt-dlp

工作原理:
  1. 优先用 yt-dlp 直接解析页面链接 (支持腾讯/优酷/B站/YouTube 等数百个网站)
  2. 如果 yt-dlp 没找到视频, 回退到 HTML 解析提取视频文件直链
"""

import os
import re
import sys
import json
import time
import hashlib
import argparse
from urllib.parse import urljoin, urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}
SESSION = requests.Session()
SESSION.headers.update(HEADERS)


# ─── 辅助函数 ──────────────────────────────────────────────────────────────────

def safe_filename(s: str) -> str:
    s = re.sub(r'[<>:"/\\|?*]', "_", s)
    if not s:
        s = "video"
    return s


def fmt_size(n: int) -> str:
    for unit in ("B", "K", "M", "G"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}T"


def print_status(symbol: str, msg: str):
    """避免 Windows GBK 编码报错的输出"""
    try:
        sys.stdout.write(f"  {symbol} {msg}\n")
    except UnicodeEncodeError:
        sys.stdout.write(f"  [{symbol}] {msg}\n")
    sys.stdout.flush()


def _find_ffmpeg() -> str | None:
    """查找 ffmpeg（脚本同目录 或 PATH）"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    local = os.path.join(script_dir, "ffmpeg.exe")
    if os.path.exists(local):
        return local
    for path in os.environ.get("PATH", "").split(os.pathsep):
        exe = os.path.join(path, "ffmpeg.exe")
        if os.path.exists(exe):
            return exe
    # linux
    for path in os.environ.get("PATH", "").split(os.pathsep):
        exe = os.path.join(path, "ffmpeg")
        if os.path.exists(exe):
            return exe
    return None


# ─── yt-dlp 下载（主力）─────────────────────────────────────────────────────────

def download_with_ytdl(url: str, output_dir: str) -> str | None:
    """用 yt-dlp 下载视频（支持各大视频平台）"""
    try:
        import yt_dlp
    except ImportError:
        print_status("!", "未安装 yt-dlp: pip install yt-dlp")
        return None

    print_status("*", "正在解析页面...")
    outtmpl = os.path.join(output_dir, "%(title).80s [%(id)s].%(ext)s")
    ydl_opts = {
        "outtmpl": outtmpl,
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": True,
        "socket_timeout": 30,
    }
    ffmpeg = _find_ffmpeg()
    if ffmpeg:
        ydl_opts["ffmpeg_location"] = ffmpeg

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if info is None:
                print_status("!", "yt-dlp 未提取到视频信息")
                return None

            # 获取下载后的文件名
            fp = info.get("requested_downloads")
            if fp:
                path = fp[0].get("filepath", "")
                if path and os.path.exists(path):
                    print_status("v", f"下载成功: {os.path.basename(path)}")
                    return path

            # fallback: 准备文件名
            filename = ydl.prepare_filename(info)
            if os.path.exists(filename):
                print_status("v", f"下载成功: {os.path.basename(filename)}")
                return filename

            ext = info.get("ext", "mp4")
            possible = filename.rsplit(".", 1)[0] + "." + ext
            if os.path.exists(possible):
                print_status("v", f"下载成功: {os.path.basename(possible)}")
                return possible

            print_status("v", "下载完成")
            return filename
    except Exception as e:
        print_status("!", f"yt-dlp 失败: {e}")
        return None


# ─── HTML/直链下载（备选）──────────────────────────────────────────────────────

def download_direct(url: str, output_dir: str, timeout: int = 30) -> str | None:
    """直接下载文件（断点续传 + 进度条）"""
    filename = safe_filename(url.split("?")[0].split("/")[-1])
    if not filename or "." not in filename:
        filename = hashlib.md5(url.encode()).hexdigest()[:12] + ".mp4"
    path = os.path.join(output_dir, filename)

    resume_header = {}
    existing_size = 0
    if os.path.exists(path):
        existing_size = os.path.getsize(path)
        resume_header["Range"] = f"bytes={existing_size}-"

    try:
        resp = SESSION.get(url, stream=True, timeout=timeout, headers=resume_header)
        if resp.status_code == 416:
            print_status("v", f"已存在: {filename}")
            return path
        if resp.status_code not in (200, 206):
            print_status("!", f"下载失败 [{resp.status_code}]: {url[:60]}...")
            return None

        mode = "ab" if resp.status_code == 206 else "wb"
        total = int(resp.headers.get("content-length", 0)) + (existing_size if resp.status_code == 206 else 0)
        downloaded = existing_size if resp.status_code == 206 else 0

        with open(path, mode) as f:
            for chunk in resp.iter_content(8192):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total > 0:
                        pct = min(downloaded / total * 100, 100)
                        bar = "=" * int(30 * downloaded / total)
                        sys.stdout.write(f"\r  [{bar:30s}] {pct:5.1f}%  {fmt_size(downloaded)}/{fmt_size(total)}")
                        sys.stdout.flush()

        sys.stdout.write(f"\r  [==============================] 100.0%  {fmt_size(downloaded)}/{fmt_size(total)}\n")
        sys.stdout.flush()
        print_status("v", f"下载完成: {filename}")
        return path
    except Exception as e:
        print_status("!", f"下载异常: {e}")
    return None


# ─── HTML 视频链接提取（备选）───────────────────────────────────────────────────

def extract_video_urls_from_html(url: str) -> list[str]:
    """从 HTML 页面中提取视频文件直链"""
    try:
        resp = SESSION.get(url, timeout=30)
        resp.raise_for_status()
    except Exception as e:
        print_status("!", f"请求失败: {e}")
        return []

    html = resp.text
    base = resp.url
    found = set()

    # 1. video / source / embed 标签
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all(["video", "embed"]):
        src = tag.get("src")
        if src:
            found.add(urljoin(base, src))
    for source in soup.find_all("source"):
        src = source.get("src")
        if src:
            found.add(urljoin(base, src))

    # 2. 正则匹配视频扩展名直链
    pattern = re.compile(r'https?://[^"\'\s<>]+\.(mp4|webm|m3u8|ts|mov|mkv|flv|avi)(?:[?"]\S*)?', re.I)
    for m in pattern.finditer(html):
        found.add(m.group(0))

    # 3. 脚本内容中的 JSON 提取
    for script in soup.find_all("script"):
        if not script.string:
            continue
        for m in pattern.finditer(script.string):
            found.add(m.group(0))

    # 过滤非资源链接
    video_domains = {urlparse(u).netloc for u in found}
    result = [u for u in found if urlparse(u).netloc in video_domains or any(
        ext in u for ext in (".mp4", ".m3u8", ".ts", ".webm", ".mov", ".mkv", ".flv")
    )]

    return list(result)


# ─── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="视频爬虫 - 爬取网页中的视频并下载",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
示例:
  python video_crawler.py "https://v.qq.com/x/cover/xxx/xxx.html"
  python video_crawler.py "https://www.bilibili.com/video/BV1xx411c7mD"
  python video_crawler.py "https://example.com/direct-video.mp4"
  python video_crawler.py URL -o ./videos -t 5
  python video_crawler.py URL --no-ytdl    # 强制只用 HTML 解析
        """,
    )
    parser.add_argument("url", help="目标网址")
    parser.add_argument("-o", "--output", default="./downloads", help="下载目录")
    parser.add_argument("-t", "--threads", type=int, default=3, help="并发下载数 (默认: 3)")
    parser.add_argument("--timeout", type=int, default=30, help="超时秒数")
    parser.add_argument("--no-ytdl", action="store_true", help="不使用 yt-dlp，只用 HTML 解析")
    parser.add_argument("--crawl", action="store_true", help="爬取模式：遍历页面内链接")
    parser.add_argument("--max-pages", type=int, default=10, help="爬取模式最大页数")
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)
    print(f"[*] 下载目录: {os.path.abspath(args.output)}")

    # ── 阶段 1: 收集视频链接 ──
    video_urls = []

    if not args.no_ytdl:
        # 先尝试 yt-dlp 直接下载（覆盖绝大多数视频网站）
        result = download_with_ytdl(args.url, args.output)
        if result:
            print(f"\n[*] 完成！视频保存在: {os.path.abspath(result)}")
            return
        print("    -> yt-dlp 未成功，尝试 HTML 解析...\n")

    # ── 阶段 2: HTML 解析 ──
    if args.crawl:
        # 爬取模式
        visited = set()
        to_visit = [args.url]
        domain = urlparse(args.url).netloc
        while to_visit and len(visited) < args.max_pages:
            page = to_visit.pop(0)
            if page in visited:
                continue
            visited.add(page)
            found = extract_video_urls_from_html(page)
            if found:
                print(f"  [页面] {page}")
                for v in found:
                    print(f"    - {v}")
                video_urls.extend(found)
            # 提取新链接
            if len(visited) < args.max_pages:
                try:
                    r = SESSION.get(page, timeout=15)
                    s = BeautifulSoup(r.text, "html.parser")
                    for a in s.find_all("a", href=True):
                        href = urljoin(page, a["href"])
                        if urlparse(href).netloc == domain and href not in visited:
                            to_visit.append(href)
                except Exception:
                    pass
            time.sleep(0.5)
    else:
        video_urls = extract_video_urls_from_html(args.url)

    if not video_urls:
        print("\n[!] 未找到视频链接。可能原因:")
        print("    - 网站需要 JavaScript 渲染 (尝试不加 --no-ytdl)")
        print("    - 网站需要登录 / 反爬")
        print("    - 页面中没有嵌入视频")
        sys.exit(0)

    # ── 下载 ──
    print(f"\n{'='*50}")
    print(f"共找到 {len(video_urls)} 个视频，开始下载...\n")

    downloaded = 0
    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        fut_map = {pool.submit(download_direct, u, args.output, args.timeout): u for u in video_urls}
        for fut in as_completed(fut_map):
            if fut.result():
                downloaded += 1

    print(f"\n{'='*50}")
    print(f"完成! 成功下载 {downloaded}/{len(video_urls)} 个视频")
    print(f"保存路径: {os.path.abspath(args.output)}")


if __name__ == "__main__":
    main()
