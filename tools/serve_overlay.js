// tools/serve_overlay.js
// Serve UI from ui/ and state from data/

const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = 3000;

const PROJECT_ROOT = path.join(__dirname, "..");
const UI_ROOT = path.join(PROJECT_ROOT, "ui");
const DATA_ROOT = path.join(PROJECT_ROOT, "data");

const OVERLAY_HTML = path.join(UI_ROOT, "overlay.html");
const MAP_PATH = path.join(UI_ROOT, "overlay_map.json");
const STATE_PATH = path.join(DATA_ROOT, "state.json");

function exists(p) {
    try { return fs.existsSync(p); } catch { return false; }
}

function must(p, name) {
    if (!exists(p)) {
        console.error(`[overlay] ERROR: missing ${name}: ${p}`);
        process.exit(1);
    }
}

must(OVERLAY_HTML, "ui/overlay.html");
must(MAP_PATH, "ui/overlay_map.json");
// state.json 可能第一次为空/不存在：不强制 must，允许先起来
if (!exists(STATE_PATH)) {
    console.warn(`[overlay] WARN: data/state.json not found yet (ok). Will 404 until core writes it.`);
}

function contentType(p) {
    const ext = path.extname(p).toLowerCase();
    if (ext === ".html") return "text/html; charset=utf-8";
    if (ext === ".css") return "text/css; charset=utf-8";
    if (ext === ".js") return "application/javascript; charset=utf-8";
    if (ext === ".json") return "application/json; charset=utf-8";
    if (ext === ".png") return "image/png";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
    if (ext === ".webp") return "image/webp";
    if (ext === ".svg") return "image/svg+xml; charset=utf-8";
    if (ext === ".ico") return "image/x-icon";
    return "application/octet-stream";
}

function send404(res, msg = "404 Not Found") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(msg);
}

function sendFile(res, filePath) {
    try {
        const st = fs.statSync(filePath);
        if (!st.isFile()) return send404(res, "404 Not File");

        res.writeHead(200, {
            "Content-Type": contentType(filePath),
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        });
        fs.createReadStream(filePath).pipe(res);
    } catch (e) {
        send404(res, "404 Not Found: " + filePath);
    }
}

// 只允许访问 UI_ROOT 内资源，防目录穿越
function safeJoinUi(urlPath) {
    const raw = decodeURIComponent(urlPath.split("?")[0].split("#")[0]).replace(/^\/+/, "");
    const norm = path.normalize(raw).replace(/^(\.\.(\/|\\|$))+/, "");
    return path.join(UI_ROOT, norm);
}

http.createServer((req, res) => {
    const pathname = (req.url || "/").split("?")[0];

    // 主页
    // 主页：兼容 ui/overlay.html 以及 ui/overlay/overlay.html
    if (pathname === "/" || pathname === "/overlay.html") {
        const p1 = path.join(UI_ROOT, "overlay.html");
        const p2 = path.join(UI_ROOT, "overlay", "overlay.html");
        const html = fs.existsSync(p1) ? p1 : (fs.existsSync(p2) ? p2 : null);
        if (!html) return send404(res, "overlay.html not found in ui/");
        return sendFile(res, html);
    }


    // 固定资源：overlay_map / state
    if (pathname === "/overlay_map.json") {
        return sendFile(res, MAP_PATH);
    }
    if (pathname === "/state.json") {
        return sendFile(res, STATE_PATH);
    }

    // icons 以及其它静态（ui 下的任何文件）
    // 例如 /icons/2205134.png -> ui/icons/2205134.png
    return sendFile(res, safeJoinUi(pathname));
}).listen(PORT, HOST, () => {
    console.log("[overlay] projectRoot =", PROJECT_ROOT);
    console.log("[overlay] uiRoot      =", UI_ROOT);
    console.log("[overlay] dataRoot    =", DATA_ROOT);
    console.log("[overlay] overlayHtml =", OVERLAY_HTML);
    console.log("[overlay] mapPath     =", MAP_PATH);
    console.log("[overlay] statePath   =", STATE_PATH);
    console.log(`[overlay] http://${HOST}:${PORT}/overlay.html`);
});
