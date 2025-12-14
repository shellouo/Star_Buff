// protocol/sr_packet.js
const zlib = require("zlib");
const pb = require("./blueprotobuf"); // 你自己的 proto / decode
const Long = require("long");

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
  constructor({ onAoiDelta }) {
    this.onAoiDelta = onAoiDelta; // 👈 只关心这个
  }

  _decompress(buf) {
    return zlib.zstdDecompressSync(buf);
  }

  _processNotify(reader, isZstd) {
    reader.readUInt64(); // serviceUuid
    reader.readUInt32(); // stubId
    const methodId = reader.readUInt32();

    let payload = reader.readBytes(reader.remaining());
    if (isZstd) payload = this._decompress(payload);

    switch (methodId) {
      case NotifyMethod.SyncNearDeltaInfo: {
        const msg = pb.SyncNearDeltaInfo.decode(payload);
        for (const delta of msg.DeltaInfos || []) {
          this.onAoiDelta?.(delta);
        }
        break;
      }
      case NotifyMethod.SyncToMeDeltaInfo: {
        const msg = pb.SyncToMeDeltaInfo.decode(payload);
        if (msg.DeltaInfo?.BaseDelta) {
          this.onAoiDelta?.(msg.DeltaInfo.BaseDelta);
        }
        break;
      }
      default:
        break;
    }
  }

  processPacket(buffer) {
    const r = new BinaryReader(buffer);

    while (r.remaining() > 0) {
      const packetSize = r.peekUInt32();
      if (packetSize < 6) break;

      const pkt = new BinaryReader(r.readBytes(packetSize));
      pkt.readUInt32(); // size
      const type = pkt.readUInt16();
      const isZstd = (type & 0x8000) !== 0;
      const msgType = type & 0x7fff;

      switch (msgType) {
        case MessageType.Notify:
          this._processNotify(pkt, isZstd);
          break;
        case MessageType.FrameDown: {
          pkt.readUInt32(); // seq
          let nested = pkt.readBytes(pkt.remaining());
          if (isZstd) nested = this._decompress(nested);
          this.processPacket(nested);
          break;
        }
        default:
          break;
      }
    }
  }
}

module.exports = { SRPacketParser };
