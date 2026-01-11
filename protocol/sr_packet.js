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
    this.selfUuid = null;   // Long（预留）
    this.selfUid = null;    // number
  }

  feedPacket(packetBytes) {
    return this.processPacket(packetBytes);
  }

  _decompressZstd(buf) {
    return zlib.zstdDecompressSync(buf);
  }

  _processNotify(reader, isZstd) {
    reader.readUInt64(); // serviceUuid
    reader.readUInt32(); // stubId
    const methodId = reader.readUInt32();

    let payload = reader.readBytes(reader.remaining());
    if (isZstd) payload = this._decompressZstd(payload);

    // ====== 1) Near Delta（场景内所有实体）======
    if (methodId === NotifyMethod.SyncNearDeltaInfo) {

      // ✅ self-only：拿到 selfUid 后就不再解 Near（否则会触发别人的 field10 全局回调）
      if (process.env.SR_SELF_ONLY === "1" && this.selfUid != null) {
        return;
      }

      const msg = pb.SyncNearDeltaInfo.decode(payload);

      for (const delta of msg.DeltaInfos || []) {
        const entityUid = delta?.Uuid ? delta.Uuid.shiftRight(16).toNumber() : null;

        const meta = {
          entityUid,
          selfUid: this.selfUid ?? null,
          isSelf: this.selfUid != null && entityUid != null && entityUid === this.selfUid,
          ts: Date.now(),
          source: "near",
        };

        this.onAoiDelta && this.onAoiDelta(delta, meta);
      }
      return;
    }

    // ====== 2) ToMe Delta（只发给你自己，顺便拿 selfUid）======
    if (methodId === NotifyMethod.SyncToMeDeltaInfo) {
      const msg = pb.SyncToMeDeltaInfo.decode(payload);
      const d = msg?.DeltaInfo;

      // ⭐ 用 ToMe 里的 Uuid 识别自己
      if (d?.Uuid) {
        const newSelfUid = d.Uuid.shiftRight(16).toNumber();
        if (this.selfUid == null || this.selfUid !== newSelfUid) {
          this.selfUid = newSelfUid;
          console.log("[SELF] selfUid =", this.selfUid);
          global.__SR_SELF_UID__ = this.selfUid;
        }
      }

      const base = d?.BaseDelta;
      if (base) {
        const entityUid = base?.Uuid ? base.Uuid.shiftRight(16).toNumber() : null;
        const meta = {
          entityUid,
          selfUid: this.selfUid ?? null,
          isSelf: true,
          ts: Date.now(),
          source: "tome",
        };
        this.onAoiDelta && this.onAoiDelta(base, meta);
      }
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
