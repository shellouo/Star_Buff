// protocol/sr_packet.js
const pb = require("./sr_blueprotobuf"); // 必须：提供 SyncNearDeltaInfo / SyncToMeDeltaInfo 的 decode
const zlib = require("zlib");

class BinaryReader {
  constructor(buffer, offset = 0) {
    this.buffer = buffer;
    this.offset = offset;
  }
  readUInt32() { const v = this.buffer.readUInt32BE(this.offset); this.offset += 4; return v; }
  readUInt16() { const v = this.buffer.readUInt16BE(this.offset); this.offset += 2; return v; }
  readUInt64() { const v = this.buffer.readBigUInt64BE(this.offset); this.offset += 8; return v; }
  readBytes(len) { const b = this.buffer.subarray(this.offset, this.offset + len); this.offset += len; return b; }
  peekUInt32() { return this.buffer.readUInt32BE(this.offset); }
  remaining() { return this.buffer.length - this.offset; }
}

const MessageType = {
  Notify: 2,
  FrameDown: 6,
};

const NotifyMethod = {
  SyncNearDeltaInfo: 0x2d,
  SyncToMeDeltaInfo: 0x2e,
};

class SRPacketParser {
  constructor(opts = {}) {
    this.onAoiDelta = opts.onAoiDelta || null;
  }

  // ✅ 兼容你 CLI：永远有这个方法
  feedPacket(packetBytes) {
    return this.processPacket(packetBytes);
  }

  _decompressZstd(buf) {
    // Node >= 20 有 zstdDecompressSync
    return zlib.zstdDecompressSync(buf);
  }

  _processNotify(reader, isZstd) {
    reader.readUInt64(); // serviceUuid
    reader.readUInt32(); // stubId
    const methodId = reader.readUInt32();

    let payload = reader.readBytes(reader.remaining());
    if (isZstd) payload = this._decompressZstd(payload);

    if (methodId === NotifyMethod.SyncNearDeltaInfo) {
      const msg = pb.SyncNearDeltaInfo.decode(payload);
      for (const delta of msg.DeltaInfos || []) {
        this.onAoiDelta && this.onAoiDelta(delta);
      }
      return;
    }

    if (methodId === NotifyMethod.SyncToMeDeltaInfo) {
      const msg = pb.SyncToMeDeltaInfo.decode(payload);
      const base = msg?.DeltaInfo?.BaseDelta;
      if (base) this.onAoiDelta && this.onAoiDelta(base);
      return;
    }
  }

  processPacket(buffer) {
    const r = new BinaryReader(buffer);

    while (r.remaining() > 0) {
      if (r.remaining() < 6) break;

      const packetSize = r.peekUInt32();
      if (packetSize < 6 || packetSize > 0x0fffff) break;
      if (r.remaining() < packetSize) break;

      const pkt = new BinaryReader(r.readBytes(packetSize));
      pkt.readUInt32(); // size
      const type = pkt.readUInt16();

      const isZstd = (type & 0x8000) !== 0;
      const msgType = type & 0x7fff;

      if (msgType === MessageType.Notify) {
        this._processNotify(pkt, isZstd);
        continue;
      }

      if (msgType === MessageType.FrameDown) {
        pkt.readUInt32(); // seq
        let nested = pkt.readBytes(pkt.remaining());
        if (isZstd) nested = this._decompressZstd(nested);
        this.processPacket(nested);
        continue;
      }
    }
  }
}

module.exports = { SRPacketParser };
