const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const THREE_ROOT = path.resolve(ROOT, "../../../fronted/node_modules/three");
const PORT = Number(process.argv[2] || 5199);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

http
  .createServer((req, res) => {
    let url = decodeURIComponent(req.url.split("?")[0]);
    let base = ROOT;
    if (url.startsWith("/three/")) {
      base = THREE_ROOT;
      url = url.slice("/three".length);
    }
    const file = path.join(base, url === "/" ? "index.html" : url);
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404);
        res.end("not found: " + file);
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  })
  .listen(PORT, "127.0.0.1", () => console.log("serving on " + PORT));
