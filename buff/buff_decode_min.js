// buff_decode_min.js
// 极简版：只负责解析 AOI 里 field=10 那一坨 Buff 数据，不依赖 protobuf 库

// --------- 基础工具：读 varint / int32 ---------

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
  let v = info.value | 0; // 转成有符号 32 位
  return { value: v, pos: info.pos };
}

// --------- 顶层：解析 AOI.field=10 的整个 payload ---------

/**
 * 解 AOI 里 field=10 的 payload（也就是我们确认的 Buff 区域）
 * @param {Uint8Array|Buffer} bytes - 整个 field=10 的 payload（不含 tag 和 length）
 * @returns {Array<Object>} events - 解出来的一堆 buff 事件
 *
 * 返回的每条 event 大概长这样：
 *  {
 *    opType,         // 1 = Add/Update, 2 = Remove（我们推测）
 *    slot,           // 槽位/索引（73/74/75 ...）
 *    ownerSlot,      // 最里层 ownerSlot
 *    buffId,         // 静态 Buff 配置 ID（如 2205261、31201）
 *    stack,          // 层数/等级
 *    durationMs,     // 持续时间 ms（8000/15000 之类）
 *    raw: {...}      // 其它原始字段（时间戳等）
 *  }
 */
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
      // repeated inner message: BuffRuntimeEntry
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
      // 其余字段暂时跳过（一般不会有）
      pos = skipByWireType(buf, pos, wt);
    }
  }

  return events;
}

// 根据 wire type 跳过（简单够用版）
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

// --------- 解每个 BuffRuntimeEntry ---------

function decodeBuffEntry(bytes) {
  let pos = 0;
  const len = bytes.length;

  let opType = null;      // field1
  let slot = null;        // field2
  let timeOrUid = null;   // field3（目前没细分）
  let payload = null;     // field5

  while (pos < len) {
    const tagInfo = readVarint(bytes, pos);
    if (!tagInfo) break;
    const tag = tagInfo.value;
    pos = tagInfo.pos;

    const field = tag >>> 3;
    const wt = tag & 7;

    switch (field) {
      case 1: { // opType
        const info = readInt32(bytes, pos);
        if (!info) return null;
        opType = info.value;
        pos = info.pos;
        break;
      }
      case 2: { // slot/index
        const info = readInt32(bytes, pos);
        if (!info) return null;
        slot = info.value;
        pos = info.pos;
        break;
      }
      case 3: { // time/uid（int64，大致先当 int32）
        const info = readInt32(bytes, pos);
        if (!info) return null;
        timeOrUid = info.value;
        pos = info.pos;
        break;
      }
      case 5: { // Payload (len-delimited)
        const lInfo = readVarint(bytes, pos);
        if (!lInfo) return null;
        const innerLen = lInfo.value;
        const start = lInfo.pos;
        const end = start + innerLen;
        const payloadBytes = bytes.subarray(start, end);
        payload = decodeBuffPayload(payloadBytes);
        pos = end;
        break;
      }
      default: {
        pos = skipByWireType(bytes, pos, wt);
        break;
      }
    }
  }

  const ev = {
    opType,
    slot,
    raw: {
      opType,
      slot,
      timeOrUid,
      payloadType: payload ? payload.payloadType : null,
      dataRaw: payload ? payload.dataRaw : null,
    },
  };

  if (payload && payload.data) {
    const d = payload.data;
    ev.ownerSlot = d.ownerSlot;
    ev.buffId = d.buffId;
    ev.stack = d.stack;
    ev.durationMs = d.durationMs;
  }

  return ev;
}

// --------- 解 BuffRuntimePayload ---------

function decodeBuffPayload(bytes) {
  let pos = 0;
  const len = bytes.length;
  let payloadType = null;  // field1: 18 / 11 之类
  let data = null;         // field2: BuffRuntimeData

  while (pos < len) {
    const tagInfo = readVarint(bytes, pos);
    if (!tagInfo) break;
    const tag = tagInfo.value;
    pos = tagInfo.pos;

    const field = tag >>> 3;
    const wt = tag & 7;

    switch (field) {
      case 1: { // payloadType
        const info = readInt32(bytes, pos);
        if (!info) return null;
        payloadType = info.value;
        pos = info.pos;
        break;
      }
      case 2: { // data (len-delimited)
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

  return {
    payloadType,
    data,
    dataRaw: data,
  };
}

// --------- 解最里层 BuffRuntimeData（有静态 Buff ID 等） ---------

function decodeBuffData(bytes) {
  let pos = 0;
  const len = bytes.length;

  const d = {
    ownerSlot: null,   // field1
    buffId: null,      // field2（静态 Buff 配置 ID）
    stack: null,       // field3
    buffId2: null,     // field5（一般等于 buffId）
    time1: null,       // field6
    time2: null,       // field7
    flag: null,        // field8
    undef10: null,     // field10
    durationMs: null,  // field11
    extraBytes: null,  // field12
  };

  while (pos < len) {
    const tagInfo = readVarint(bytes, pos);
    if (!tagInfo) break;
    const tag = tagInfo.value;
    pos = tagInfo.pos;

    const field = tag >>> 3;
    const wt = tag & 7;

    switch (field) {
      case 1: { // ownerSlot
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.ownerSlot = info.value;
        pos = info.pos;
        break;
      }
      case 2: { // buffId
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.buffId = info.value;
        pos = info.pos;
        break;
      }
      case 3: { // stack
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.stack = info.value;
        pos = info.pos;
        break;
      }
      case 5: { // buffId2
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.buffId2 = info.value;
        pos = info.pos;
        break;
      }
      case 6: { // time1
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.time1 = info.value;
        pos = info.pos;
        break;
      }
      case 7: { // time2
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.time2 = info.value;
        pos = info.pos;
        break;
      }
      case 8: { // flag
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.flag = info.value;
        pos = info.pos;
        break;
      }
      case 10: { // undef10
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.undef10 = info.value;
        pos = info.pos;
        break;
      }
      case 11: { // durationMs
        const info = readInt32(bytes, pos);
        if (!info) return d;
        d.durationMs = info.value;
        pos = info.pos;
        break;
      }
      case 12: { // extra bytes
        const lInfo = readVarint(bytes, pos);
        if (!lInfo) return d;
        const innerLen = lInfo.value;
        const start = lInfo.pos;
        const end = start + innerLen;
        d.extraBytes = bytes.subarray(start, end);
        pos = end;
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

// --------- 导出给别的脚本用 ---------
module.exports = {
  decodeBuffField10,
};

// --------- 简单命令行示例（可选） ---------
// 用法：node buff_decode_min.js buff_chunk.bin
if (require.main === module) {
  const fs = require("fs");
  const path = process.argv[2];
  if (!path) {
    console.log("用法: node buff_decode_min.js <field10_payload.bin>");
    process.exit(1);
  }
  const buf = fs.readFileSync(path);
  const events = decodeBuffField10(buf);
  console.log("解析到 Buff 事件数：", events.length);
  for (const e of events) {
    console.log(e);
  }
}
