// buff_decode_min.js
// ����棺ֻ������� AOI �� field=10 ��һ�� Buff ���ݣ������� protobuf ��

// --------- �������ߣ��� varint / int32 ---------

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
  let v = info.value | 0; // ת���з��� 32 λ
  return { value: v, pos: info.pos };
}

// --------- ���㣺���� AOI.field=10 ������ payload ---------

/**
 * �� AOI �� field=10 �� payload��Ҳ��������ȷ�ϵ� Buff ����
 * @param {Uint8Array|Buffer} bytes - ���� field=10 �� payload������ tag �� length��
 * @returns {Array<Object>} events - �������һ�� buff �¼�
 *
 * ���ص�ÿ�� event ��ų�������
 *  {
 *    opType,         // 1 = Add/Update, 2 = Remove�������Ʋ⣩
 *    slot,           // ��λ/������73/74/75 ...��
 *    ownerSlot,      // ����� ownerSlot
 *    buffId,         // ��̬ Buff ���� ID���� 2205261��31201��
 *    stack,          // ����/�ȼ�
 *    durationMs,     // ����ʱ�� ms��8000/15000 ֮�ࣩ
 *    raw: {...}      // ����ԭʼ�ֶΣ�ʱ����ȣ�
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
      // �����ֶ���ʱ������һ�㲻���У�
      pos = skipByWireType(buf, pos, wt);
    }
  }

  return events;
}

// ���� wire type �������򵥹��ð棩
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

// --------- ��ÿ�� BuffRuntimeEntry ---------

function decodeBuffEntry(bytes) {
  let pos = 0;
  const len = bytes.length;

  let opType = null;      // field1
  let slot = null;        // field2
  let timeOrUid = null;   // field3��Ŀǰûϸ�֣�
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
      case 3: { // time/uid��int64�������ȵ� int32��
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

// --------- �� BuffRuntimePayload ---------

function decodeBuffPayload(bytes) {
  let pos = 0;
  const len = bytes.length;
  let payloadType = null;  // field1: 18 / 11 ֮��
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

// --------- ������� BuffRuntimeData���о�̬ Buff ID �ȣ� ---------

function decodeBuffData(bytes) {
  let pos = 0;
  const len = bytes.length;

  const d = {
    ownerSlot: null,   // field1
    buffId: null,      // field2����̬ Buff ���� ID��
    stack: null,       // field3
    buffId2: null,     // field5��һ����� buffId��
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

// --------- ��������Ľű��� ---------
module.exports = {
  decodeBuffField10,
};

// --------- ��������ʾ������ѡ�� ---------
// �÷���node buff_decode_min.js buff_chunk.bin
if (require.main === module) {
  const fs = require("fs");
  const path = process.argv[2];
  if (!path) {
    console.log("�÷�: node buff_decode_min.js <field10_payload.bin>");
    process.exit(1);
  }
  const buf = fs.readFileSync(path);
  const events = decodeBuffField10(buf);
  console.log("������ Buff �¼�����", events.length);
  for (const e of events) {
    console.log(e);
  }
}