#!/usr/bin/env python3
"""Native messaging helper for the Comment My Site extension.

Chrome starts this script and talks to it over stdin/stdout (4-byte length + JSON).
It receives the exported PNG as base64 chunks and writes it to ~/Desktop.

Protocol (one reply per request):
  {"type": "ping"}                      -> {"ok": true, "dir": "..."}
  {"type": "begin", "filename": "x.png"} -> {"ok": true}
  {"type": "chunk", "data": "<base64>"}   -> {"ok": true}
  {"type": "end"}                        -> {"ok": true, "path": "/Users/.../Desktop/x.png"}
  {"type": "reveal", "path": "..."}      -> {"ok": true}   (shows the file in Finder)
"""

import base64
import json
import os
import struct
import subprocess
import sys

VERSION = 1
OUTPUT_DIR = os.path.expanduser(os.environ.get("CMS_OUTPUT_DIR") or "~/Desktop")


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def safe_name(name):
    name = os.path.basename(str(name or "")).strip().lstrip(".")
    name = "".join("_" if c in '/\\:*?"<>|' or ord(c) < 32 else c for c in name)
    if not name:
        name = "comments.png"
    if not name.lower().endswith(".png"):
        name += ".png"
    return name


def unique_path(directory, name):
    stem, ext = os.path.splitext(name)
    path = os.path.join(directory, name)
    n = 2
    while os.path.exists(path):
        path = os.path.join(directory, f"{stem} ({n}){ext}")
        n += 1
    return path


class Upload:
    def __init__(self, filename):
        self.name = safe_name(filename)
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        self.tmp_path = os.path.join(OUTPUT_DIR, f".{self.name}.{os.getpid()}.part")
        self.file = open(self.tmp_path, "wb")

    def write(self, b64):
        self.file.write(base64.b64decode(b64))

    def finish(self):
        self.file.close()
        path = unique_path(OUTPUT_DIR, self.name)
        os.replace(self.tmp_path, path)
        return path

    def abort(self):
        try:
            self.file.close()
        except Exception:
            pass
        try:
            os.remove(self.tmp_path)
        except OSError:
            pass


def main():
    upload = None
    try:
        while True:
            msg = read_message()
            if msg is None:
                break
            kind = msg.get("type")
            try:
                if kind == "ping":
                    send_message({"ok": True, "version": VERSION, "dir": OUTPUT_DIR})
                elif kind == "begin":
                    if upload:
                        upload.abort()
                    upload = Upload(msg.get("filename"))
                    send_message({"ok": True})
                elif kind == "chunk":
                    if not upload:
                        raise RuntimeError("no upload in progress")
                    upload.write(msg.get("data", ""))
                    send_message({"ok": True})
                elif kind == "end":
                    if not upload:
                        raise RuntimeError("no upload in progress")
                    path = upload.finish()
                    upload = None
                    send_message({"ok": True, "path": path})
                elif kind == "reveal":
                    path = msg.get("path") or ""
                    if not os.path.isfile(path):
                        raise RuntimeError("file not found")
                    subprocess.run(["open", "-R", path], check=False)
                    send_message({"ok": True})
                else:
                    raise RuntimeError(f"unknown message type: {kind}")
            except Exception as exc:  # report to the extension instead of crashing
                if upload and kind in ("begin", "chunk", "end"):
                    upload.abort()
                    upload = None
                send_message({"ok": False, "error": str(exc)})
    finally:
        if upload:
            upload.abort()


if __name__ == "__main__":
    main()
