// capture_core.js
// 依赖：npm i cap
const { Cap, decoders } = require("cap");
const PROTOCOL = decoders.PROTOCOL;
const { SRPacketParser } = require("../protocol/sr_packet");

// ===== 新增：全局日志+统计 =====
let totalPacketCount = 0; // 总抓包数
let totalAoiDeltaCount = 0; // 总AOI Delta数
let lastPacketTime = Date.now();
let tcp_last_progress = 0; // ✅ 新增：上次成功拼进 _data 并推进 next_seq 的时间

function envOn(key, def = "0") {
  const v = String(process.env[key] ?? def).trim();
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

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
  // ===== 新增：抓包启动日志 =====
  logger.log("[🚀 抓包启动] 设备：", device);
  logger.log("[ℹ️  提示] 游戏内放技能/触发被动，才能看到Buff解析结果");

  // 每2秒打印统计
// 每2秒打印统计（默认关闭，SR_LOG_STAT=1 才开启）
  const statInterval = envOn("SR_LOG_STAT", "0")
      ? setInterval(() => {
        const idleTime = Date.now() - lastPacketTime;
        logger.log(
            `[📊 抓包统计] 总抓包：${totalPacketCount} | AOI Delta：${totalAoiDeltaCount} | 最后抓包：${idleTime}ms前`
        );
      }, 2000)
      : null;


  const c = new Cap();
  const filter = "ip and tcp";
  const bufSize = 10 * 1024 * 1024;
  const buffer = Buffer.alloc(65535);

  const linkType = c.open(device, filter, bufSize, buffer);
  logger.log("[cap] 设备已打开 | 链路类型：", linkType);

  c.setMinBytes && c.setMinBytes(0);

  const tcp_cache = new Map(); // seq -> payload
  let tcp_next_seq = -1;
  let _data = Buffer.alloc(0);
  let tcp_last_time = 0;
  let tcp_seen_time = 0; // 最近一次收到任何TCP分片的时间
  const TCP_STALL_RESET_MS = 3000; // 先用 3 秒，后面可调 2000~8000

  // ===== 高性能队列（指针实现，避免 shift O(n)）=====
  const queue = [];
  let qHead = 0;
  let lastOverflowLog = 0;
// 生产者：抓到一个包就 push
  c.on("packet", (nbytes) => {
    totalPacketCount++;
    lastPacketTime = Date.now();
    queue.push(Buffer.from(buffer.subarray(0, nbytes)));

    // ---- 防爆：队列过长时丢旧包 ----
    const MAX_Q = 2000; // 经验值：overlay 足够
    const qLen = queue.length - qHead;
    if (qLen > MAX_Q) {
      qHead = queue.length - MAX_Q;
      logger.warn(`[cap] queue overflow, drop old packets, keep=${MAX_Q}`);
    }
  });

  let running = true;

  (async () => {
    while (running) {
      // 有包可处理
      if (qHead < queue.length) {
        const pkt = queue[qHead++];
        processFrame(pkt);

        // ---- 定期收缩数组，避免无限增长 ----
        if (qHead > 1000) {
          queue.splice(0, qHead);
          qHead = 0;
        }
      } else {
        // 没包就稍微让出事件循环
        await new Promise((r) => setTimeout(r, 1));
      }
    }
  })();

  function resetReassembly(reason = "manual") {
    logger.warn(`[cap] reset reassembly (${reason})`);
    _data = Buffer.alloc(0);
    tcp_cache.clear();
    tcp_next_seq = -1;
    tcp_last_time = 0;
    tcp_seen_time = 0;
  }



  const cleaner = startFragmentCleaner();

  function processFrame(frameBuffer) {
    const now = Date.now();
    if (tcp_next_seq !== -1 && tcp_last_time && (now - tcp_last_time > TCP_STALL_RESET_MS) && _data.length === 0) {
      logger.warn(`[cap] reassembly stalled ${(now - tcp_last_time)}ms, reset`);
      _data = Buffer.alloc(0);
      tcp_cache.clear();
      tcp_next_seq = -1;
      tcp_last_time = 0;
      // tcp_seen_time 不清也行，清了更干净
      // tcp_seen_time = 0;
    }

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
    tcp_seen_time = Date.now();

    // 初始同步：猜测协议包头（UInt32BE 长度）
    const seqno = tcpPacket.info.seqno >>> 0;

// 初始同步：猜测协议包头（UInt32BE 长度）
    if (tcp_next_seq === -1) {
      // ① 未同步时：不要把所有 TCP 包都塞进 cache（否则闲置时会被小包塞爆）
      if (tcpPayload.length >= 4) {
        const L = tcpPayload.readUInt32BE(0);
        if (L > 6 && L < 0x0fffff) {
          // ② 命中一个像“包头”的段：从这里开始同步
          tcp_next_seq = seqno;

          // ③ 清空旧 cache（旧的基本都是噪音），只保留当前段
          tcp_cache.clear();
          tcp_cache.set(seqno, tcpPayload);
        }
      }
      // 还没同步到，就直接返回（不缓存）
      if (tcp_next_seq === -1) return;
    }

// ✅ 已同步后：才正常缓存
    if (((tcp_next_seq - seqno) << 0) <= 0) {
      tcp_cache.set(seqno, tcpPayload);
    }


// ✅ 起点已知后，再把“太旧的 seq”过滤掉（可选但建议保留）
    for (const k of tcp_cache.keys()) {
      if (((tcp_next_seq - k) << 0) > 0) tcp_cache.delete(k);
    }


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

    if (tcp_seen_time && Date.now() - tcp_seen_time > FRAGMENT_TIMEOUT) {
      logger.warn("[cap] 流超时，重置");
      _data = Buffer.alloc(0);
      tcp_cache.clear();
      tcp_next_seq = -1;
      tcp_last_time = 0;   // ✅ 防止老时间戳造成误判
    }

  }


  return {
    stop() {
      running = false;
      clearInterval(cleaner);
      if (statInterval) clearInterval(statInterval); // 停止统计
      try { c.close(); } catch {}
      logger.log("[🛑 抓包停止] 总抓包：", totalPacketCount);
    },
    reset(reason) { resetReassembly(reason|| "manual"); }
  };
}

// ------------------- 独立工具入口：startLive -------------------
/**
 * @param {string} device cap.deviceList() 返回的 name
 * @param {(delta:any)=>void} onAoiDelta  回调 AOI delta（你在这里抽 buff）
 */
function startLive({ device, logger = console, onAoiDelta }) {
  // ===== 新增：AOI Delta 日志 =====
  const wrappedOnAoiDelta = (delta) => {
    totalAoiDeltaCount++;
    const wrappedOnAoiDelta = (delta, meta) => {
      totalAoiDeltaCount++;

      const fieldsLen = delta?.Fields?.length ?? 0;

      // ✅ 1) 默认不打 AOI Delta 逐条日志（否则必炸）
      //   需要时手动开：SR_LOG_AOI=1
      const logAoi = process.env.SR_LOG_AOI === "1";

      // ✅ 2) 开了日志也别刷“字段数=0”的空包（除非 SR_LOG_AOI_EMPTY=1）
      const logEmpty = process.env.SR_LOG_AOI_EMPTY === "1";

      if (logAoi && (fieldsLen > 0 || logEmpty)) {
        logger.log(`[🔍 收到AOI Delta(${totalAoiDeltaCount})] fields=${fieldsLen} uid=${meta?.entityUid ?? "?"} self=${meta?.isSelf ? 1 : 0}`);
      }

      try { onAoiDelta && onAoiDelta(delta, meta); }
      catch (e) { logger.error("[onAoiDelta] 错误:", e); }
    };
    try { onAoiDelta && onAoiDelta(delta); }
    catch (e) { logger.error("[onAoiDelta] 错误:", e); }
  };

  const parser = new SRPacketParser({
    onAoiDelta: wrappedOnAoiDelta,
  });

  return startCapture({
    device,
    logger,
    onPacket: (packetBytes) => {
      try {
        parser.processPacket(packetBytes);
      } catch (e) {
        logger.error("[SRPacketParser] 错误:", e);
      }
    },
  });
}

// ------------------- 导出 -------------------
module.exports = { listDevices, resolveDevice, startCapture, startLive };