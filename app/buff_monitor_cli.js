// buff_monitor_cli.js - 内嵌解析逻辑，无需 buff_decode_min.js
const http = require("node:http");
const { createWriter } = require("../io/writer");
const path = require("path");

const overlayWriter = createWriter({
  outPath: path.join(__dirname, "..", "data", "state.json"),
});

const fs = require("fs");
const { listDevices, resolveDevice, startLive } = require("../net/capture_core");
const readline = require("node:readline");

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
  RAW: envOn("SR_LOG_RAW", "0"),          // 原始事件/兜底调试
};

const logger = {
  info(...a) { if (!LOG.SILENT) console.log(...a); },
  warn(...a) { if (!LOG.SILENT) console.warn(...a); },
  error(...a){ console.error(...a); },

  buff(...a) { if (!LOG.SILENT && LOG.BUFF) console.log(...a); },
  field10(...a){ if (!LOG.SILENT && LOG.FIELD10) console.log(...a); },
  raw(...a)  { if (!LOG.SILENT && LOG.RAW) console.log(...a); },
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
const BUFF_SEEN_PATH = path.join(__dirname, "../data/buff_seen.json");
const STATE_PATH     = path.join(__dirname, "../data/state.json");

// state.json 的内存副本
let state = loadJson(STATE_PATH, {});
let stateDirty = false;

// 删除一个 buff
function delBuff(idStr) {
  if (state[idStr] !== undefined) {
    delete state[idStr];
    stateDirty = true;
  }
}

// 自动过期回收（GC）
function gcExpired(now = Date.now()) {
  for (const [idStr, v] of Object.entries(state)) {
    if (!v || typeof v.durUntil !== "number") continue;

    // ✅ durUntil === 0 → 表示“无持续时间的存在型 buff”
    // 只能靠 BUFF- 删除，GC 不处理
    if (v.durUntil === 0) continue;

    // ✅ 只有“真的有持续时间”的 buff，才走过期回收
    if (v.durUntil <= now) {
      delete state[idStr];
      stateDirty = true;
    }
  }
}


// 写回 state.json（只有真的变了才写）
function flushState() {
  if (!stateDirty) return;
  saveJson(STATE_PATH, state);
  stateDirty = false;
}




let buffMap = loadJson(BUFF_MAP_PATH, {});
let buffSeen = loadJson(BUFF_SEEN_PATH, {});

// slot -> last buffId（为了解决 remove 不带 buffId）
const slotLastBuffId = new Map();
// buffId(string) -> Map(slot(number) -> {durUntil, cdUntil, stack})
const activeSlotsById = new Map();

function aggSlots(slots) {
  let durUntil = 0, cdUntil = 0, stack = 1;

  // dur/cd 取最大（最晚结束的那层）；stack 取最大（层数buff更稳）
  for (const s of slots.values()) {
    const du = Number(s.durUntil ?? 0);
    const cu = Number(s.cdUntil  ?? 0);
    const st = Number(s.stack    ?? 1);
    if (du > durUntil) durUntil = du;
    if (cu > cdUntil)  cdUntil  = cu;
    if (st > stack)    stack    = st;
  }
  return { durUntil, cdUntil, stack };
}



// ===== 1. 内嵌所有解析逻辑（原 buff_decode_min.js 代码） =====
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
        try { writer && writer.resetAll && writer.resetAll(); } catch {}

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
    buffId2: null,
    time1: null,
    time2: null,
    flag: null,
    undef10: null,
    durationMs: null,
    extraBytes: null,
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

  // selfUid 还没拿到就先不输出（避免前期刷屏）fs
  //if (selfUid == null) return;

  // 只要自己的
  //if (entityUid !== selfUid) return;

  // 可选：field10 收到日志（默认关，避免刷屏）
  logger.field10(`[📥 field10] uid=${entityUid} len=${payloadBytes.length}`);

  try {
    const buffEvents = decodeBuffField10(payloadBytes);

    let seenChanged = false;
    for (const ev of buffEvents) {
      // ===== MON / SNIFF（只观察，不改状态）=====
      const TARGET = "3002611";
      if (String(ev.buffId) === TARGET) {
        console.log("[MON]", {
          opType: ev.opType,
          slot: ev.slot,
          buffId: ev.buffId,
          stack: ev.stack,
          durationMs: ev.durationMs,
          allVarints: ev._allVarints,
        });
      }
      // ===== 1) REMOVE =====
      if (ev.opType === 2) {
        const lastId = slotLastBuffId.get(ev.slot);

        // buffId=1 / null 都当不可信：优先用 lastId
        const trustedId =
            (ev.buffId != null && ev.buffId > 0 && ev.buffId !== 1) ? ev.buffId : lastId;

        const trustedStr = (trustedId != null) ? String(trustedId) : null;
        const name = trustedStr ? (buffMap[trustedStr] ?? "(未映射)") : "(unknown)";

        logger.buff(`[BUFF-] slot=${ev.slot} buffId=${trustedStr ?? "?"} name=${name}`);

        // 删 state：只删“已映射(=写入过 overlay)”的 buffId
        // 删 state：按 slot 删（避免覆盖/刷新误删）
        if (trustedStr && buffMap[trustedStr]) {
          const idStr = trustedStr;
          const slot = ev.slot;

          const slots = activeSlotsById.get(idStr);
          if (slots) {
            slots.delete(slot);

            if (slots.size === 0) {
              activeSlotsById.delete(idStr);
              overlayWriter.delOne(idStr);
              logger.buff(`[BUFF-DEL] slot=${slot} deleted id=${idStr} (no slots left)`);
            } else {
              const agg = aggSlots(slots);
              overlayWriter.setOne(idStr, agg);
              logger.buff(`[BUFF-DEL] slot=${slot} keep id=${idStr} (slots left=${slots.size})`);
            }
          } else {
            // 没有 slots 记录，兜底：直接删（理论上不该常发生）
            overlayWriter.delOne(idStr);
            logger.buff(`[BUFF-DEL] slot=${slot} deleted id=${idStr} (no slot record)`);
          }
        } else {
          // 未映射：不删，避免误删
        }


        // 解绑 slot
        slotLastBuffId.delete(ev.slot);
        continue;
      }

      // ===== 2) ADD/UPDATE =====

      // if (ev.buffId != null && ev.buffId > 0) {
      if (ev.opType === 1 && ev.buffId != null && ev.buffId > 0 && ev.buffId !== 1) {

        // 记录 slot 当前对应的 buffId（给 REMOVE 用）
        slotLastBuffId.set(ev.slot, ev.buffId);

        const idStr = String(ev.buffId);
        const name = buffMap[idStr] ?? "(未映射)";

        // 自动收集未知 buffId（终端可见，用于补 buff_map.json）
        if (!buffSeen[idStr]) {
          buffSeen[idStr] = {
            firstSeen: Date.now(),
            count: 0,
            sample: { slot: ev.slot, durMs: ev.durationMs ?? null, stack: ev.stack ?? null }
          };
          seenChanged = true;
        }
        buffSeen[idStr].count++;

        const durUntil =
            (ev.durationMs != null && ev.durationMs > 0) ? (Date.now() + ev.durationMs) : 0;

        const durSec = (ev.durationMs != null && ev.durationMs > 0)
            ? (ev.durationMs / 1000)
            : 0;

        logger.buff(
            `[BUFF+] buffId=${idStr} name=${name} slot=${ev.slot}` +
            ` dur=${durSec.toFixed(1)}s` +
            ` durUntil=${durUntil}` +
            ` stack=${ev.stack ?? "?"}` +
            ` op=${ev.opType}`
        );

        // overlay/state：只写已映射的
        if (buffMap[idStr]) {
          const slot = ev.slot;
          let slots = activeSlotsById.get(idStr);
          if (!slots) { slots = new Map(); activeSlotsById.set(idStr, slots); }

          slots.set(slot, { durUntil, cdUntil: 0, stack: ev.stack ?? 1 });

          const agg = aggSlots(slots);
          overlayWriter.setOne(idStr, agg);
          // flush 仍旧用你的定时器
        }


        continue;
      }

      // ===== 3) 其他原始事件 =====
      if (process.env.SR_LOG_RAW_BUFF === "1") {
        console.log(`[RAW] opType=${ev.opType} slot=${ev.slot} payloadType=${ev.raw?.payloadType}`);
      }
    }


    // 有新 buffId 才落盘，避免频繁写文件
    if (seenChanged) saveJson(BUFF_SEEN_PATH, buffSeen);

    // 保留 dump（你原有功能）
    if (process.env.SR_DUMP_FIELD10 === "1") {
      const dumpName = `dump_field10_${Date.now()}.bin`;
      fs.writeFileSync(dumpName, payloadBytes);
      console.log(`[📤 Dump] 保存到：${dumpName}`);
    }
  } catch (e) {
    console.error("[❌ 解析错误]", e.message);
  }
};

setInterval(() => {
  overlayWriter.flush();
}, 200);
// global.__SR_ON_AOI_FIELD10__ = (payloadBytes, meta) => {
//   const selfUid = global.__SR_SELF_UID__;   // 你自己存起来
//   const entityUid = meta?.entityUid;
//   // ✅ selfUid 还没拿到就先不输出（避免前期刷屏）
//   if (selfUid == null) return;
//
//   // ✅ 只要自己的
//   if (entityUid !== selfUid) return;
//
//   console.log(`[📥 收到field10] 字节长度：${payloadBytes.length}`);
//   try {
//     const buffEvents = decodeBuffField10(payloadBytes);
//     console.log(`[🔨 解析结果] 找到Buff事件：${buffEvents.length}个`);
//
//     buffEvents.forEach(ev => {
//       if (ev.buffId > 0 && ev.durationMs > 0) {
//         console.log(`[✅ 有效Buff] opType=${ev.opType} | slot=${ev.slot} | buffId=${ev.buffId} | 持续=${ev.durationMs/1000}秒`);
//       } else {
//         console.log(`[⚠️  原始Buff] opType=${ev.opType} | slot=${ev.slot} | payloadType=${ev.raw.payloadType}`);
//       }
//     });
//
//     // 保存dump文件
//     if (process.env.SR_DUMP_FIELD10 === "1") {
//       const dumpName = `dump_field10_${Date.now()}.bin`;
//       fs.writeFileSync(dumpName, payloadBytes);
//       console.log(`[📤 Dump] 保存到：${dumpName}`);
//     }
//   } catch (e) {
//     console.error("[❌ 解析错误]", e.message);
//   }
// };

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



    // 1) 先尝试从命令行拿 --dev（保持老用法）
    let devInput = args.find(arg => arg.startsWith("--dev="))?.split("=")[1];

    const devFlagPos = args.indexOf("--dev");
    if (!devInput && devFlagPos !== -1) {
      devInput = args[devFlagPos + 1];
    }


    // 2) 如果没传 --dev，就用 user_config 记住的 dev
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
      onAoiDelta: (delta) => {}
    });
    const cfgServer = startConfigServer({
      port: 8787,
      logger: console,
      capture,
      writer: overlayWriter,
    });
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", (s) => {
      const cmd = String(s).trim().toLowerCase();
      if (cmd === "r" || cmd === "reset") {
        try { capture.reset("manual"); } catch {}
        try { overlayWriter.resetAll(); } catch {}
        console.log("[reset] ok");
      }

    });
    console.log('[hint] type "r" + Enter to reset capture+state');

    global.__cap = capture;
    console.log("[cap] expose: global.__cap.reset('manual')");


    process.on("SIGINT", () => {
      try { cfgServer.close(); } catch {}
      capture.stop();
      process.exit(0);
    });
  }
})().catch(e => { console.error(e); process.exit(1); });
