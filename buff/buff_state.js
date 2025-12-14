// buff_state.js
class BuffState {
  constructor({ icdConfig = {} } = {}) {
    this.icdConfig = icdConfig;           // { buffId: icdMs }
    this.lastProcAt = new Map();          // buffId -> ms
    this.active = new Map();              // key -> {buffId, stack, durationMs, lastSeenMs}
  }

  // key 策略：先用 slot，后面你如果能拿到 actorUuid/ownerUuid 再升级
  _keyOf(e) {
    return `${e.ownerSlot ?? "?"}:${e.slot};
  }

  feedBuffEvents(events, nowMs = Date.now()) {
    for (const e of events) {
      // 忽略 Lite Entry（只有 slot 没 buffId）
      if (e.buffId == null) continue;

      const key = this._keyOf(e);

      // 你当前的 opType 还没完整验证 remove=2，但先留着
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
        lines.push(`buffId=${buffId} ICD=${(icdMs/1000).toFixed(1)}s  (未触发过)`);
        continue;
      }
      const remain = Math.max(0, icdMs - (nowMs - last));
      lines.push(`buffId=${buffId}  remain=${(remain/1000).toFixed(2)}s`);
    }
    return lines;
  }

  // 输出当前 Buff 列表（用于 CLI）
  getActiveLines() {
    const lines = [];
    for (const [key, v] of this.active.entries()) {
      lines.push(`${key} buffId=${v.buffId} stack=${v.stack} dur=${v.durationMs}`);
    }
    return lines;
  }
}

module.exports = { BuffState };
