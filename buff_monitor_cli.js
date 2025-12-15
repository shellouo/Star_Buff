// buff_monitor_cli.js - 内嵌解析逻辑，无需 buff_decode_min.js
const fs = require("fs");
const path = require("path");
const { listDevices, resolveDevice, startLive } = require("./capture_core");

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
global.__SR_ON_AOI_FIELD10__ = (payloadBytes) => {
  console.log(`[📥 收到field10] 字节长度：${payloadBytes.length}`);
  try {
    const buffEvents = decodeBuffField10(payloadBytes);
    console.log(`[🔨 解析结果] 找到Buff事件：${buffEvents.length}个`);

    buffEvents.forEach(ev => {
      if (ev.buffId > 0 && ev.durationMs > 0) {
        console.log(`[✅ 有效Buff] opType=${ev.opType} | slot=${ev.slot} | buffId=${ev.buffId} | 持续=${ev.durationMs/1000}秒`);
      } else {
        console.log(`[⚠️  原始Buff] opType=${ev.opType} | slot=${ev.slot} | payloadType=${ev.raw.payloadType}`);
      }
    });

    // 保存dump文件
    if (process.env.SR_DUMP_FIELD10 === "1") {
      const dumpName = `dump_field10_${Date.now()}.bin`;
      fs.writeFileSync(dumpName, payloadBytes);
      console.log(`[📤 Dump] 保存到：${dumpName}`);
    }
  } catch (e) {
    console.error("[❌ 解析错误]", e.message);
  }
};

// ===== 3. CLI 逻辑 =====
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "list") {
  const devs = listDevices();
  console.log("📱 可用抓包设备：");
  devs.forEach((d, i) => {
    console.log(`  [${i}] ${d.name} - ${d.description}`);
    if (d.addresses.length) console.log(`     IP：${d.addresses.join(", ")}`);
  });
} else if (cmd === "live") {
  const devInput = args.find(arg => arg.startsWith("--dev="))?.split("=")[1] || args[args.indexOf("--dev") + 1];
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

  process.on("SIGINT", () => {
    capture.stop();
    process.exit(0);
  });
} else {
  console.log("📖 用法：");
  console.log("  列出设备：node buff_monitor_cli.js list");
  console.log("  实时抓包：node buff_monitor_cli.js live --dev <设备索引>");
}