// capture_core.js
// 依赖：npm i cap
const { startServerCapture } = require("./server_capture");
const { Cap } = require("cap");
const { SRPacketParser } = require("../protocol/sr_packet");



let totalAoiDeltaCount = 0; // 总AOI Delta数

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

// ------------------- 独立工具入口：startLive -------------------
/**
 * @param {string} device cap.deviceList() 返回的 name
 * @param {(delta:any)=>void} onAoiDelta  回调 AOI delta（你在这里抽 buff）
 */
function startLive({ device, logger = console, onAoiDelta }) {
  // ===== 新增：AOI Delta 日志 =====
  const wrappedOnAoiDelta = (delta, meta) => {
    totalAoiDeltaCount++;

    const fieldsLen = delta?.Fields?.length ?? 0;

    const logAoi = process.env.SR_LOG_AOI === "1";
    const logEmpty = process.env.SR_LOG_AOI_EMPTY === "1";

    if (logAoi && (fieldsLen > 0 || logEmpty)) {
      logger.log(
          `[🔍 收到AOI Delta(${totalAoiDeltaCount})] fields=${fieldsLen} uid=${meta?.entityUid ?? "?"} self=${meta?.isSelf ? 1 : 0}`
      );
    }

    try { onAoiDelta && onAoiDelta(delta, meta); }
    catch (e) { logger.error("[onAoiDelta] 错误:", e); }
  };


  const parser = new SRPacketParser({
    onAoiDelta: wrappedOnAoiDelta,
  });

  return startServerCapture({
    device,
    logger,
    onPacket(packetBytes) {
      parser.processPacket(packetBytes); // 你原来的解析层照旧
    },
    onServerChange(serverKey) {
      logger.warn("[cap] server changed:", serverKey);
      // 这里你可以选择 resetAllState（可选）
    }
  });

}

// ------------------- 导出 -------------------
module.exports = { listDevices, resolveDevice, startLive };