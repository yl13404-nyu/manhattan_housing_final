# This file was developed with assistance from Codex.

"""Serve the final dashboard and its data. Python stdlib only."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class DashboardHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    dashboard = Path(__file__).resolve().parent
    handler = partial(DashboardHandler, directory=str(dashboard))
    # 仅监听本机 / Bind only to the local computer.
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        print(f"Dashboard: http://127.0.0.1:{args.port}/", flush=True)
        print("Press Ctrl+C to stop.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
