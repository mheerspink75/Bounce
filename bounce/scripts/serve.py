"""Static file server for the browser app.

`python -m http.server --directory public` is not enough on Windows. There,
mimetypes reads the registry, where .js is still mapped to text/plain, and the
browser then refuses the entry module:

    Failed to load module script: Expected a JavaScript-or-Wasm module script
    but the server responded with a MIME type of "text/plain".

Linux reads /etc/mime.types instead, which is why the same command works under
WSL. Registering the correct type up front makes it behave the same everywhere.
"""

import functools
import mimetypes
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

mimetypes.add_type("text/javascript", ".js")

PORT = 8080
DIRECTORY = "public"


def main() -> None:
    handler = functools.partial(SimpleHTTPRequestHandler, directory=DIRECTORY)
    with ThreadingHTTPServer(("", PORT), handler) as httpd:
        print(f"serving {DIRECTORY}/ on http://localhost:{PORT}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()