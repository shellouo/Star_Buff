// capture_core.js
// 依赖：npm i cap
const { Cap, decoders } = require("cap");
const PROTOCOL = decoders.PROTOCOL;

const { SRPacketParser } = require("./protocol/sr_packet");

// ------------------- 设备选择 -------------------
function listDevices() {
  const devs = Cap.deviceList();
  return devs.map((d, i) => ({
    index: i,
    name: d.name,
    description: d.description || "",
    addresses: (d.addresses || []).map((a) => a.addr).filter(Boolean),
  }));
}

function resolveDevice(input) {
  const devs = Cap.deviceList();
  if (!devs.length) return null;
  if (input == null) return devs[0].name;

  const s = String(input);
  if (/^\d+$/.test(s)) return devs[Number(s)]?.name || null;

  const key = s.toLowerCase();
  const hit = devs.find(
    (d) =>
      (d.name || "").toLowerCase().includes(key) ||
      (d.description || "").toLowerCase().includes(key)
  );
  return hit?.name || null;
}

// ------------------- IPv4 分片重组 -------------------
const FRAGMENT_TIMEOUT = 15_000;
const fragmentIpCache = new Map();

function getIPv4PayloadReassembled(frameBuffer, ethOffset) {
  const ipPacket = decoders.IPV4(frameBuffer, ethOffset);
  const ipInfo = ipPacket.info;

  const isFragment = ipInfo.fragoffset > 0 || (ipInfo.flags && ipInfo.flags.mf);
  if (!isFragment) {
    return Buffer.from(
      frameBuffer.subarray(
        ipPacket.offset,
        ipPacket.offset + (ipInfo.totallen - ipPacket.hdrlen)
      )
    );
  }

  const key = `${ipInfo.srcaddr}->${ipInfo.dstaddr}|${ipInfo.id}|${ipInfo.protocol}`;
  const now = Date.now();

  let entry = fragmentIpCache.get(key);
  if (!entry) {
    entry = { fragments: [], timestamp: now };
    fragmentIpCache.set(key, entry);
  }
  entry.fragments.push(Buffer.from(frameBuffer.subarray(ethOffset)));
  entry.timestamp = now;

  const moreFragments = ipInfo.flags && ipInfo.flags.mf;
  if (moreFragments) return null;

  const fragments = entry.fragments;
  if (!fragments?.length) return null;

  let totalLength = 0;
  const fragmentData = [];

  for (const buf of fragments) {
    const ip = decoders.IPV4(buf);
    const offset = ip.info.fragoffset * 8;
    const payloadLength = ip.info.totallen - ip.hdrlen;
    const payload = Buffer.from(buf.subarray(ip.offset, ip.offset + payloadLength));
    fragmentData.push({ offset, payload });
    totalLength = Math.max(totalLength, offset + payloadLength);
  }

  fragmentData.sort((a, b) => a.offset - b.offset);

  const fullPayload = Buffer.alloc(totalLength);
  for (const f of fragmentData) f.payload.copy(fullPayload, f.offset);

  fragmentIpCache.delete(key);
  return fullPayload;
}

function startFragmentCleaner() {
  return setInterval(() => {
    const now = Date.now();
    for (const [k, v] of fragmentIpCache) {
      if (now - v.timestamp > FRAGMENT_TIMEOUT) fragmentIpCache.delete(k);
    }
  }, 10_000);
}

// ------------------- 抓包 + TCP 重组 + 切包 -------------------
function startCapture({ device, logger = console, onPacket }) {
  const c = new Cap();
  const filter = "ip and tcp";
  const bufSize = 10 * 1024 * 1024;
  const buffer = Buffer.alloc(65535);

  const linkType = c.open(device, filter, bufSize, buffer);
  logger.log("[cap] open device =", device, "linkType =", linkType);

  c.setMinBytes && c.setMinBytes(0);

  const tcp_cache = new Map(); // seq -> payload
  let tcp_next_seq = -1;
  let _data = Buffer.alloc(0);
  let tcp_last_time = 0;

  const queue = [];
  c.on("packet", (nbytes) => {
    queue.push(Buffer.from(buffer.subarray(0, nbytes)));
  });

  const cleaner = startFragmentCleaner();

  function processFrame(frameBuffer) {
    let ethPacket;
    if (linkType === "ETHERNET") {
      ethPacket = decoders.Ethernet(frameBuffer);
    } else if (linkType === "NULL") {
      ethPacket = { info: { type: frameBuffer.readUInt32LE() === 2 ? 2048 : 0 }, offset: 4 };
    } else if (linkType === "LINKTYPE_LINUX_SLL") {
      ethPacket = { info: { type: frameBuffer.readUInt32BE(14) === 0x0800 ? 2048 : 0 }, offset: 16 };
    } else {
      return;
    }
    if (ethPacket.info.type !== PROTOCOL.ETHERNET.IPV4) return;

    const ipPayload = getIPv4PayloadReassembled(frameBuffer, ethPacket.offset);
    if (!ipPayload) return;

    const tcpPacket = decoders.TCP(ipPayload);
    const tcpHdrLen = tcpPacket.hdrlen;
    const tcpPayload = Buffer.from(ipPayload.subarray(tcpHdrLen));
    if (!tcpPayload.length) return;

    // 初始同步：猜测协议包头（UInt32BE 长度）
    if (tcp_next_seq === -1) {
      if (tcpPayload.length >= 4) {
        const L = tcpPayload.readUInt32BE(0);
        if (L > 6 && L < 0x0fffff) tcp_next_seq = tcpPacket.info.seqno >>> 0;
      }
      if (tcp_next_seq === -1) return;
    }

    const seqno = tcpPacket.info.seqno >>> 0;
    if (((tcp_next_seq - seqno) << 0) <= 0) {
      tcp_cache.set(seqno, tcpPayload);
    }

    while (tcp_cache.has(tcp_next_seq)) {
      const seg = tcp_cache.get(tcp_next_seq);
      tcp_cache.delete(tcp_next_seq);
      _data = _data.length ? Buffer.concat([_data, seg]) : seg;
      tcp_next_seq = (tcp_next_seq + seg.length) >>> 0;
      tcp_last_time = Date.now();
    }

    while (_data.length >= 4) {
      const packetSize = _data.readUInt32BE(0);
      if (packetSize < 6 || packetSize > 0x0fffff) {
        _data = Buffer.alloc(0);
        tcp_cache.clear();
        tcp_next_seq = -1;
        return;
      }
      if (_data.length < packetSize) break;

      const one = _data.subarray(0, packetSize);
      _data = _data.subarray(packetSize);

      onPacket && onPacket(one);
    }

    if (tcp_last_time && Date.now() - tcp_last_time > FRAGMENT_TIMEOUT) {
      logger.warn("[cap] stream timeout, reset");
      _data = Buffer.alloc(0);
      tcp_cache.clear();
      tcp_next_seq = -1;
    }
  }

  let running = true;
  (async () => {
    while (running) {
      const pkt = queue.shift();
      if (pkt) processFrame(pkt);
      else await new Promise((r) => setTimeout(r, 1));
    }
  })();

  return {
    stop() {
      running = false;
      clearInterval(cleaner);
      try { c.close(); } catch {}
    },
  };
}

// ------------------- 独立工具入口：startLive -------------------
/**
 * @param {string} device cap.deviceList() 返回的 name
 * @param {(delta:any)=>void} onAoiDelta  回调 AOI delta（你在这里抽 buff）
 */
function startLive({ device, logger = console, onAoiDelta }) {
  const parser = new SRPacketParser({
    onAoiDelta: (delta) => {
      try { onAoiDelta && onAoiDelta(delta); }
      catch (e) { logger.error("[onAoiDelta] error:", e); }
    },
  });

  return startCapture({
    device,
    logger,
    onPacket: (packetBytes) => {
      try {
        parser.processPacket(packetBytes);
      } catch (e) {
        logger.error("[SRPacketParser] error:", e);
      }
    },
  });
}

module.exports = { listDevices, resolveDevice, startLive };
