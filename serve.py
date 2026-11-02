"""本地静态服务器：多线程 + Range 支持。

python -m http.server 是单线程且不支持 Range 请求，浏览器加载 14MB wasm 与视频时
会互相阻塞（表现为视频一直 readyState=0）。这个脚本解决这两点。

用法：
    python serve.py            # http://127.0.0.1:8765/web/
    python serve.py 9000
"""

import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8765


class RangeHandler(SimpleHTTPRequestHandler):
    """给 SimpleHTTPRequestHandler 加上 Range 支持（视频拖动/部分加载需要）。"""

    range_re = re.compile(r"bytes=(\d*)-(\d*)")

    def send_head(self):
        rng = self.headers.get("Range")
        if not rng:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        if not os.path.isfile(path):
            self.send_error(404, "File not found")
            return None

        m = self.range_re.fullmatch(rng.strip())
        if not m:
            return super().send_head()

        size = os.path.getsize(path)
        start_s, end_s = m.group(1), m.group(2)
        # bytes=-N 是「最后 N 字节」的 suffix range，不是 0~N；浏览器拖动进度时会发。
        # 两种都解析错的话，视频会从错误位置开始播，难排查。
        if not start_s and not end_s:
            self.send_error(416, "Requested Range Not Satisfiable")
            return None
        if not start_s:
            length = int(end_s)
            if length <= 0:
                self.send_error(416, "Requested Range Not Satisfiable")
                return None
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
            end = min(end, size - 1)
        if start >= size or start > end:
            self.send_error(416, "Requested Range Not Satisfiable")
            return None

        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._range_remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_range_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)
        self._range_remaining = None

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    handler = partial(RangeHandler, directory=ROOT)
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"serving {ROOT}")
    print(f"open  http://127.0.0.1:{port}/web/")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
