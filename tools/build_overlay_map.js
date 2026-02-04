// tools/build_overlay_map.js
// 将 config/overlay_map.edit.jsonc (允许 // 和 /* */ 注释) 生成纯 JSON：config/overlay_map.json
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const IN  = path.join(root, "ui", "overlay_map.edit.jsonc");
const OUT = path.join(root, "ui", "overlay_map.json");

// 去掉注释：保留字符串内容，不误伤 "http://"
function stripJsonComments(input) {
    let out = "";
    let i = 0;
    let inStr = false;
    let quote = "";
    while (i < input.length) {
        const ch = input[i];
        const next = input[i + 1];

        if (inStr) {
            out += ch;
            if (ch === "\\") {
                // 跳过转义字符后的一个字符
                if (i + 1 < input.length) out += input[i + 1], i += 2;
                else i += 1;
                continue;
            }
            if (ch === quote) inStr = false;
            i += 1;
            continue;
        }

        if (ch === '"' || ch === "'") {
            inStr = true;
            quote = ch;
            out += ch;
            i += 1;
            continue;
        }

        // 行注释 //
        if (ch === "/" && next === "/") {
            i += 2;
            while (i < input.length && input[i] !== "\n") i += 1;
            continue;
        }

        // 块注释 /* ... */
        if (ch === "/" && next === "*") {
            i += 2;
            while (i < input.length) {
                if (input[i] === "*" && input[i + 1] === "/") { i += 2; break; }
                i += 1;
            }
            continue;
        }

        out += ch;
        i += 1;
    }
    return out;
}

function main() {
    if (!fs.existsSync(IN)) {
        console.error("[build_overlay_map] missing:", IN);
        process.exit(1);
    }

    const raw = fs.readFileSync(IN, "utf8");
    const stripped = stripJsonComments(raw);

    let obj;
    try {
        obj = JSON.parse(stripped);
    } catch (e) {
        console.error("[build_overlay_map] JSON parse failed:", e?.message || e);
        process.exit(1);
    }

    fs.writeFileSync(OUT, JSON.stringify(obj, null, 2), "utf8");
    console.log("[build_overlay_map] OK ->", OUT);
}

main();
