// buff_monitor_cli.js
const monCore = require("./mon_core");
const { resetAllState } = require("./mon_core");

const http = require("node:http");
const path = require("path");
const fs = require("fs");
// ===== 全局 Buff 状态表（key = uid:buffId）=====
global.__BUFF_STATE_MAP__ = new Map();

const { listDevices, resolveDevice, startLive } = require("../net/capture_core");
const readline = require("node:readline");
// ===== timestamp patch: prefix all console logs =====
(function patchConsoleTimestamp(){
  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(n).padStart(3, "0");

  function ts() {
    const d = new Date();
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
  }

  const wrap = (orig) => (...args) => orig(`[${ts()}]`, ...args);

  console.log = wrap(console.log);
  console.warn = wrap(console.warn);
  console.error = wrap(console.error);
})();

// ===== 显示范围开关 =====
// true = 只显示自己（默认）
// false = 显示所有实体
global.__SR_ONLY_SELF__ = true;
// ✅ 统一用户配置文件
const USER_CONFIG_PATH = path.join(__dirname, "../config/user_config.json");
// ===== 日志分级 & 开关（Step 1）=====
function envOn(key, def = "0") {
  const v = String(process.env[key] ?? def).trim();
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}
const LOG = {
  // 总开关（可选）：SR_SILENT=1 直接静音（除了 error）
  SILENT: envOn("SR_SILENT", "0"),
  // 细分开关：默认全关
  BUFF: envOn("SR_LOG_BUFF", "1"),        // BUFF+/BUFF- 细节
  FIELD10: envOn("SR_LOG_FIELD10", "0"),  // field10 收包长度/条数
  RAW: envOn("SR_LOG_RAW", "0"), // 原始事件/兜底调试
  PRO: envOn("SR_LOG_PRO", "0"),      // 处理后日志（默认关）
};
const logger = {
  info(...a) { if (!LOG.SILENT) console.log(...a); },
  warn(...a) { if (!LOG.SILENT) console.warn(...a); },
  error(...a){ console.error(...a); },
  buff(...a) { if (!LOG.SILENT && LOG.BUFF) console.log(...a); },
  field10(...a){ if (!LOG.SILENT && LOG.FIELD10) console.log(...a); },
  raw(...a)  { if (!LOG.SILENT && LOG.RAW) console.log(...a); },
  pro(...a)  { if (!LOG.SILENT && LOG.PRO) console.log(...a); },
};
function loadUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveUserConfig(cfg) {
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}
function loadJson(path, def = {}) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); }
  catch { return def; }
}
function saveJson(path, obj) {
  fs.writeFileSync(path, JSON.stringify(obj, null, 2), "utf8");
}
const BUFF_MAP_PATH  = path.join(__dirname, "../config/buff_map.json");
// ===== 1. 内嵌所有解析逻辑=====
function readVarint(buf, pos) {
  let x = 0;
  let s = 0;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    x |= (b & 0x7f) << s;
    if ((b & 0x80) === 0) {
      return { value: x >>> 0, pos };
    }
    s += 7;
  }
  return null;
}
function printDevicesPretty() {
  const devs = listDevices();

  console.log("\n可用网卡列表：");

  if (!devs || devs.length === 0) {
    console.log("  (未枚举到网卡，请确认已安装 Npcap 且有权限)");
    console.log("");
    return devs;
  }

  for (const d of devs) {
    const desc = (d.description || d.name || "Unknown").trim();

    // 优先显示 IPv4
    const ipv4 = (d.addresses || []).find(
        (a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)
    );

    // 简单标签（只是好看，不影响逻辑）
    const lower = desc.toLowerCase();
    let tag = "";
    if (lower.includes("wi-fi") || lower.includes("wifi") || lower.includes("wireless")) tag = "Wi-Fi";
    else if (lower.includes("ethernet") || lower.includes("gigabit") || lower.includes("pci")) tag = "LAN";
    else if (lower.includes("loopback")) tag = "Loopback";

    const tagStr = tag ? `[${tag}] ` : "";
    const ipStr = ipv4 ? `  ${ipv4}` : "";

    console.log(`  [${String(d.index).padStart(2, " ")}] ${tagStr}${desc}${ipStr}`);
  }

  console.log(""); // 结尾空行
  return devs;
}
function startConfigServer({ port = 8787, logger = console, capture, writer } = {}) {

  const server = http.createServer(async (req, res) => {
    // --- CORS（overlay 在 3000，这里 8787，必须允许跨域）---
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // 读 body
    const readJsonBody = () =>
        new Promise((resolve, reject) => {
          let raw = "";
          req.on("data", (c) => (raw += c));
          req.on("end", () => {
            if (!raw) return resolve(null);
            try { resolve(JSON.parse(raw)); }
            catch (e) { reject(e); }
          });
        });

    try {
      // POST /capture/reset -> 重置抓包重组 + 清空 state.json
      if (req.method === "POST" && url.pathname === "/capture/reset") {
        try { capture && capture.reset && capture.reset("ui"); } catch {}
        resetAllState("capture reset");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true }));
      }


      // GET /config  -> 返回 user_config.json
      if (req.method === "GET" && url.pathname === "/config") {
        const cfg = loadUserConfig();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify(cfg));
      }
      // GET /device/list  -> 返回网卡列表（给前端下拉框用）
      if (req.method === "GET" && url.pathname === "/device/list") {
        const devs = listDevices().map(d => {
          const desc = (d.description || d.name || "Unknown").trim();

          // 找一个 IPv4（只用于显示）
          const ipv4 = (d.addresses || []).find(a => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)) || null;

          // 做个简单 tag（显示更友好）
          const lower = desc.toLowerCase();
          let tag = "";
          if (lower.includes("wi-fi") || lower.includes("wifi") || lower.includes("wireless")) tag = "Wi-Fi";
          else if (lower.includes("ethernet") || lower.includes("gigabit") || lower.includes("pci")) tag = "LAN";
          else if (lower.includes("loopback")) tag = "Loopback";

          return {
            index: d.index,
            name: d.name,
            description: desc,
            ipv4,
            tag,
          };
        });

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true, devices: devs }));
      }
      // POST /device/select  body: { index: 4 }
      if (req.method === "POST" && url.pathname === "/device/select") {
        const body = await readJsonBody();
        const idx = Number(body?.index);

        if (!Number.isInteger(idx) || idx < 0) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ ok: false, error: "bad index" }));
        }

        // 校验一下 index 是否存在（避免写垃圾）
        const devs = listDevices();
        const found = devs.find(d => d.index === idx);
        if (!found) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ ok: false, error: "device not found" }));
        }

        const cfg = loadUserConfig();
        cfg.device = cfg.device || {};
        cfg.device.index = idx;
        saveUserConfig(cfg);

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true, index: idx }));
      }

      // POST /overlay/pin  body: { id: "2205391", value: true/false }
      if (req.method === "POST" && url.pathname === "/overlay/pin") {
        const body = await readJsonBody();
        const id = String(body?.id ?? "");
        const value = !!body?.value;

        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ ok: false, error: "missing id" }));
        }

        const cfg = loadUserConfig();
        cfg.overlay = cfg.overlay || {};
        cfg.overlay.pin = cfg.overlay.pin || {};
        cfg.overlay.pin[id] = value;

        saveUserConfig(cfg);

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true, id, value }));
      }


      // POST /overlay/watch  body: { id: "2205391", value: true/false }
      if (req.method === "POST" && url.pathname === "/overlay/watch") {
        const body = await readJsonBody();
        const id = String(body?.id ?? "");
        const value = !!body?.value;

        if (!id) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ ok: false, error: "missing id" }));
        }

        const cfg = loadUserConfig();
        cfg.overlay = cfg.overlay || {};
        cfg.overlay.watch = cfg.overlay.watch || {};
        cfg.overlay.watch[id] = value;

        saveUserConfig(cfg);

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true, id, value }));
      }

      // GET /overlay/watch -> 只返回 watch 表（可选）
      if (req.method === "GET" && url.pathname === "/overlay/watch") {
        const cfg = loadUserConfig();
        const watch = cfg?.overlay?.watch || {};
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify(watch));
      }
      // POST /state/clear -> 清空 Buff 栏（等价 CLI 的 c）
      if (req.method === "POST" && url.pathname === "/state/clear") {
        resetAllState("ui clear");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true }));
      }


      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    }
  });

  server.listen(port, "127.0.0.1", () => {
    logger.log(`[cfg] 配置服务已启动: http://127.0.0.1:${port}`);
  });

  return server;
}
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
      rl.question(question, (ans) => {
        rl.close();
        resolve(ans);
      })
  );
}
async function selectDeviceInteractive() {
  const devs = printDevicesPretty(); // ✅ 你已经写好了：打印并返回 dev 列表
  if (!devs || devs.length === 0) {
    throw new Error("No devices");
  }

  while (true) {
    const ans = (await ask("请选择网卡编号（例如 4），直接回车取消： ")).trim();
    if (ans === "") return null;

    const n = Number(ans);
    if (!Number.isInteger(n)) {
      console.log("输入无效：请输入整数编号。");
      continue;
    }

    const found = devs.find((d) => d.index === n);
    if (!found) {
      console.log("输入无效：编号不存在，请重试。");
      continue;
    }

    console.log(`已选择 dev=${n}：${found.description || found.name || "Unknown"}\n`);
    return n;
  }
}
function readInt32(buf, pos) {
  const info = readVarint(buf, pos);
  if (!info) return null;
  let v = info.value | 0;
  return { value: v, pos: info.pos };
}
function skipByWireType(buf, pos, wt) {
  switch (wt) {
    case 0: {
      const info = readVarint(buf, pos);
      return info ? info.pos : buf.length;
    }
    case 1:
      return pos + 8;
    case 2: {
      const lInfo = readVarint(buf, pos);
      if (!lInfo) return buf.length;
      return lInfo.pos + lInfo.value;
    }
    case 5:
      return pos + 4;
    default:
      return buf.length;
  }
}
function decodeBuffData(bytes) {
  let pos = 0;
  const len = bytes.length;
  const d = {
    ownerSlot: null,
    buffId: null,
    stack: null,
    durationMs: null,
  };

  while (pos < len) {
    const tagInfo = readVarint(bytes, pos);
    if (!tagInfo) break;
    const tag = tagInfo.value;
    pos = tagInfo.pos;
    const field = tag >>> 3;
    const wt = tag & 7;
    switch (field) {
      case 1: {
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.ownerSlot = info.value;
        pos = info.pos;
        break;
      }
      case 2: {
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.buffId = info.value;
        pos = info.pos;
        break;
      }
      case 3: {
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.stack = info.value;
        pos = info.pos;
        break;
      }
      case 11: {
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.durationMs = info.value;
        pos = info.pos;
        break;
      }
      default: {
        pos = skipByWireType(bytes, pos, wt);
        break;
      }
    }
  }
  return d;
}
function decodeBuffPayload(bytes) {
  let pos = 0;
  const len = bytes.length;
  let payloadType = null;
  let data = null;
  while (pos < len) {
    const tagInfo = readVarint(bytes, pos);
    if (!tagInfo) break;
    const tag = tagInfo.value;
    pos = tagInfo.pos;
    const field = tag >>> 3;
    const wt = tag & 7;
    switch (field) {
      case 1: {
        const info = readInt32(bytes, pos);
        if (!info) return null;
        payloadType = info.value;
        pos = info.pos;
        break;
      }
      case 2: {
        const lInfo = readVarint(bytes, pos);
        if (!lInfo) return null;
        const innerLen = lInfo.value;
        const start = lInfo.pos;
        const end = start + innerLen;
        data = decodeBuffData(bytes.subarray(start, end));
        pos = end;
        break;
      }
      default: {
        pos = skipByWireType(bytes, pos, wt);
        break;
      }
    }
  }
  return { payloadType, data, dataRaw: data };
}
function decodeBuffEntry(bytes) {
  let pos = 0;
  const len = bytes.length;
  let opType = null;
  let slot = null;
  let payload = null;
  while (pos < len) {
    const tagInfo = readVarint(bytes, pos);
    if (!tagInfo) break;
    const tag = tagInfo.value;
    pos = tagInfo.pos;
    const field = tag >>> 3;
    const wt = tag & 7;
    switch (field) {
      case 1: {
        const info = readInt32(bytes, pos);
        if (!info) return null;
        opType = info.value;
        pos = info.pos;
        break;
      }
      case 2: {
        const info = readInt32(bytes, pos);
        if (!info) return null;
        slot = info.value;
        pos = info.pos;
        break;
      }
      case 5: {
        const lInfo = readVarint(bytes, pos);
        if (!lInfo) return null;
        const innerLen = lInfo.value;
        const start = lInfo.pos;
        const end = start + innerLen;
        payload = decodeBuffPayload(bytes.subarray(start, end));
        pos = end;
        break;
      }
      default: {
        pos = skipByWireType(bytes, pos, wt);
        break;
      }
    }
  }
  const ev = { opType, slot, raw: { opType, slot, payloadType: payload?.payloadType } };
  if (payload && payload.data) {
    const d = payload.data;
    ev.ownerSlot = d.ownerSlot;
    ev.buffId = d.buffId;
    ev.stack = d.stack;
    ev.durationMs = d.durationMs;
  }
  return ev;
}
function decodeBuffField10(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const len = buf.length;
  let pos = 0;
  const events = [];
  while (pos < len) {
    const tagInfo = readVarint(buf, pos);
    if (!tagInfo) break;
    const tag = tagInfo.value;
    pos = tagInfo.pos;
    const field = tag >>> 3;
    const wt = tag & 7;
    if (field === 2 && wt === 2) {
      const lInfo = readVarint(buf, pos);
      if (!lInfo) break;
      const innerLen = lInfo.value;
      const start = lInfo.pos;
      const end = start + innerLen;
      const entryBytes = buf.subarray(start, end);
      const ev = decodeBuffEntry(entryBytes);
      if (ev) events.push(ev);
      pos = end;
    } else {
      // pos = skipByWireType(buf, pos, wt);
      pos = skipByWireType(buf, pos, wt);
    }
  }
  return events;
}
// ===== 2. 全局回调（解析field10） =====
function loadJson(p, def = {}) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; }
}
function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}
// ===== field10 回调 =====
global.__SR_ON_AOI_FIELD10__ = (payloadBytes, meta) => {
  const selfUid = global.__SR_SELF_UID__;
  const entityUid = meta?.entityUid;
  // selfUid 还没拿到就先不输出（避免刷屏）
  if (selfUid == null) return;

  // 根据开关决定是否只看自己
  if (global.__SR_ONLY_SELF__ && entityUid !== selfUid) return;

  // 可选：field10 收到日志（默认关，避免刷屏）
  logger.field10(`[📥 field10] uid=${entityUid} len=${payloadBytes.length}`);

  try {
    const buffEvents = decodeBuffField10(payloadBytes);

    let seenChanged = false;
    for (const ev of buffEvents) {
      monCore.onBuffEvent(ev, meta, logger);
    }
    // 保留 dump
    if (process.env.SR_DUMP_FIELD10 === "1") {
      const dumpName = `dump_field10_${Date.now()}.bin`;
      fs.writeFileSync(dumpName, payloadBytes);
      console.log(`[📤 Dump] 保存到：${dumpName}`);
    }
  } catch (e) {
    console.error("[❌ 解析错误]", e.message);
  }
};
// ===== [STEP2] 监听状态流（只验证，不处理）=====
// ===== [STEP3] 把 BuffInfo 转成最小状态对象=====
// BuffInfoSync

global.__SR_ON_AOI_BUFF_STATE__ = function (buffSync, meta) {
  const list = buffSync?.BuffInfos;
  if (!Array.isArray(list) || list.length === 0) return;

  for (const b of list) {
    const state = {
      uid: meta.entityUid,
      baseId: b.BaseId,
      layer: b.Layer ?? null,
      count: b.Count ?? null,
      durationMs: b.Duration ?? null,
    };
    // ===== STEP5: 只缓存“像 buff 的状态” =====
    if (state.layer != null || state.durationMs != null) {
      const buffIdStr = String(state.baseId);
      const key = `${state.uid}:${buffIdStr}`;
      global.__BUFF_STATE_MAP__.set(key, state);
    }

  }
};


// ===== 3. CLI 逻辑 =====
const args = process.argv.slice(2);
const cmd = args[0];
(async () => {
  if (cmd === "list") {
    printDevicesPretty();
    return;
  } else if (cmd === "live") {
    const wantSelect = args.includes("--select") || args.includes("-s");
    const cfg = loadUserConfig();



    // 1) 先尝试从命令行拿
    let devInput = args.find(arg => arg.startsWith("--dev="))?.split("=")[1];

    const devFlagPos = args.indexOf("--dev");
    if (!devInput && devFlagPos !== -1) {
      devInput = args[devFlagPos + 1];
    }


    // 2) 用 user_config 记住的 dev
    if (!devInput && cfg?.device?.index != null) {
      devInput = String(cfg.device.index);
      console.log(`🔁 使用已保存网卡 dev=${devInput}（user_config.json）`);
    }

    // 3) 如果用户要求 --select，或者第一次没有任何 dev，则进入交互选择
    if (wantSelect || !devInput) {
      const picked = await selectDeviceInteractive();

      if (picked == null) {
        if (!cfg?.device?.index && !devInput) {
          console.error("❌ 未选择网卡，且没有已保存的默认网卡。程序退出。");
          process.exit(1);
        }

        console.log("已取消选择，继续使用已保存的网卡。");
      } else {
        devInput = String(picked);

        // ✅ 保存到 user_config.json
        cfg.device = cfg.device || {};
        cfg.device.index = picked;
        saveUserConfig(cfg);

        console.log(`✅ 已保存默认网卡 dev=${picked} 到 user_config.json`);
      }
    }
    console.log("[DBG] devInput =", devInput, " typeof=", typeof devInput);
    console.log("[DBG] saved cfg.device.index =", cfg?.device?.index);


    const device = resolveDevice(devInput);
    if (!device) {
      console.error("❌ 设备不存在！运行 node buff_monitor_cli.js list 查看设备");
      process.exit(1);
    }
    const capture = startLive({
      device,
      logger: console,
      onAoiDelta: (delta, meta) => {
      }


    });
    const cfgServer = startConfigServer({
      port: 8787,
      logger: console,
      capture,
    });
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", (s) => {
      const cmd = String(s).trim().toLowerCase();

      // reset
      if (cmd === "r" || cmd === "reset") {
        try { capture.reset("manual"); } catch {}
        resetAllState("manual reset");
        console.log("[reset] capture + state reset");
        return;
      }


      // clear state (buff bar)
      if (cmd === "c" || cmd === "clear") {
        resetAllState("manual clear");
        console.log("[clear] state cleared (buff bar)");
        return;
      }

      // ===== 日志热开关（按键 + Enter）=====
      if (cmd === "b") {
        LOG.BUFF = !LOG.BUFF;
        console.log(`[toggle] LOG.BUFF = ${LOG.BUFF ? "ON" : "OFF"}`);
        return;
      }

      if (cmd === "f") {
        LOG.FIELD10 = !LOG.FIELD10;
        console.log(`[toggle] LOG.FIELD10 = ${LOG.FIELD10 ? "ON" : "OFF"}`);
        return;
      }

      if (cmd === "w") {
        LOG.RAW = !LOG.RAW;
        console.log(`[toggle] LOG.RAW = ${LOG.RAW ? "ON" : "OFF"}`);
        return;
      }

      if (cmd === "s") {
        LOG.SILENT = !LOG.SILENT;
        console.log(`[toggle] LOG.SILENT = ${LOG.SILENT ? "ON" : "OFF"} (error 仍会输出)`);
        return;
      }
      if (cmd === "p") {
        LOG.PRO = !LOG.PRO;
        console.log(`[toggle] LOG.PRO = ${LOG.PRO ? "ON" : "OFF"}`);
        return;
      }
      if (cmd === "a") {
        global.__SR_ONLY_SELF__ = !global.__SR_ONLY_SELF__;
        console.log(
            `[toggle] ONLY_SELF = ${global.__SR_ONLY_SELF__ ? "ON (只看自己)" : "OFF (显示全部实体)"}`
        );
        return;
      }

      if (cmd === "?" || cmd === "h" || cmd === "help") {
        console.log(
            `[keys]\n` +
            `  r + Enter  reset capture+state\n` +
            `  b + Enter  toggle BUFF+/BUFF-\n` +
            `  f + Enter  toggle field10 log\n` +
            `  w + Enter  toggle RAW log\n` +
            `  s + Enter  toggle SILENT\n` +
            `  a + Enter  toggle ONLY_SELF (self / all)\n`
        );
        return;
      }
    });

    console.log('[hint] r=reset, b=buffLog, f=field10Log, w=rawLog, s=silent, h=help  (都需要 + Enter)');


    global.__cap = capture;
    console.log("[cap] expose: global.__cap.reset('manual')");


    process.on("SIGINT", () => {
      try { cfgServer.close(); } catch {}
      capture.stop();
      process.exit(0);
    });
  }
})().catch(e => { console.error(e); process.exit(1); });
