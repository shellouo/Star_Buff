// buff_state.js
class BuffState {
  constructor({ icdConfig = {} } = {}) {
    this.icdConfig = icdConfig;           // { buffId: icdMs }
    this.lastProcAt = new Map();          // buffId -> ms
    this.active = new Map();              // key -> {buffId, stack, durationMs, lastSeenMs}
  }

  // key 策略：先用 slot，后面你如果能拿到 actorUuid/ownerUuid 再升级
  _keyOf(e) {
    // ✅ 修复：你原来这里少了反引号/引号，导致后面全炸
    return String(e.ownerSlot ?? "?") + ":" + String(e.slot);
  }

  feedBuffEvents(events, nowMs = Date.now()) {
    for (const e of events) {
      // 忽略 Lite Entry（只有 slot 没 buffId）
      if (e.buffId == null) continue;

      const key = this._keyOf(e);

      // remove（先按 2 处理）
      if (e.opType === 2) {
        this.active.delete(key);
        continue;
      }

      // 更新当前 Buff 列表
      this.active.set(key, {
        buffId: e.buffId,
        stack: e.stack ?? null,
        durationMs: e.durationMs ?? null,
        lastSeenMs: nowMs,
      });

      // ===== ICD 触发点：把 “出现 Full Entry” 当作一次 proc =====
      // 去抖：同一个 buffId 在 500ms 内重复出现不算多次
      const last = this.lastProcAt.get(e.buffId) ?? 0;
      if (nowMs - last > 500) {
        this.lastProcAt.set(e.buffId, nowMs);
      }
    }
  }

  // 输出 ICD 面板（用于 CLI）
  getIcdLines(nowMs = Date.now()) {
    const lines = [];

    for (const [buffIdStr, icdMs] of Object.entries(this.icdConfig)) {
      const buffId = Number(buffIdStr);
      const last = this.lastProcAt.get(buffId);

      if (!last) {
        // ✅ 修复：你原来这里用了 key/v（根本不存在），直接输出一条“未触发”
        lines.push("buffId=" + buffId + "  remain=" + (icdMs / 1000).toFixed(2) + "s (not yet)");
        continue;
      }

      const remain = Math.max(0, icdMs - (nowMs - last));
      lines.push(
        "buffId=" + buffId +
        "  remain=" + (remain / 1000).toFixed(2) + "s"
      );
    }

    return lines;
  }

  // 输出当前 Buff 列表（用于 CLI）
  getActiveLines() {
    const lines = [];
    for (const [key, v] of this.active.entries()) {
      // ✅ 先别用模板字符串，避免你环境里再炸；等你确认都正常了再换回也行
      lines.push(
        String(key) +
        " buffId=" + v.buffId +
        " stack=" + v.stack +
        " dur=" + v.durationMs
      );
    }
    return lines;
  }
}

module.exports = { BuffState };
