// app/mon_core.js
"use strict";
// ===== 叠层规则用的状态 =====
// key: mainBuffId (string)
let overlayDirty = false;
const fs = require("fs");
const path = require("path");
const { createWriter } = require("../io/writer");
const BUFF_MAP_PATH  = path.join(__dirname, "../config/buff_map.json");
const BUFF_SEEN_PATH = path.join(__dirname, "../data/buff_seen.json");
const STATE_PATH     = path.join(__dirname, "../data/state.json");

function loadJson(p, def = {}) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); }
    catch { return def; }
}
function saveJson(p, obj) {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

const overlayWriter = createWriter({ outPath: STATE_PATH });

// ===== 业务状态 =====
let buffMap  = loadJson(BUFF_MAP_PATH, {});
let buffSeen = loadJson(BUFF_SEEN_PATH, {});
const slotLastBuffId = new Map();
const activeSlotsById = new Map();

function aggSlots(slots) {
    let durUntil = 0, cdUntil = 0;
    for (const s of slots.values()) {
        if ((s.durUntil ?? 0) > durUntil) durUntil = s.durUntil;
        if ((s.cdUntil  ?? 0) > cdUntil)  cdUntil  = s.cdUntil;
    }
    return { durUntil, cdUntil, stack: 1 };
}


// ===== 对外唯一入口 =====
function onBuffEvent(ev, meta, logger = console) {
    const entityUid = meta?.entityUid;

    // ===== REMOVE =====
    if (ev.opType === 2) {
        const lastId = slotLastBuffId.get(ev.slot);
        const trustedId =
            (ev.buffId && ev.buffId !== 1) ? ev.buffId : lastId;

        if (!trustedId) return;

        const idStr = String(trustedId);
        const name = buffMap[idStr] ?? "(未映射)";
        logger.buff(`[BUFF-] uid=${entityUid} buffId=${idStr} name=${name} slot=${ev.slot} op=${ev.opType}`);


        const slots = activeSlotsById.get(idStr);
        if (slots) {
            slots.delete(ev.slot);
            if (slots.size === 0) {
                activeSlotsById.delete(idStr);
                overlayWriter.delOne(idStr);
                overlayDirty = true;
            } else {
                overlayWriter.setOne(idStr, aggSlots(slots));
                overlayDirty = true;
            }
        }

        slotLastBuffId.delete(ev.slot);
        return;
    }

    // ===== ADD / UPDATE =====
    if (ev.opType === 1 && ev.buffId && ev.buffId !== 1) {
        const idStr = String(ev.buffId);
        slotLastBuffId.set(ev.slot, ev.buffId);

        if (!buffSeen[idStr]) {
            buffSeen[idStr] = { firstSeen: Date.now(), count: 0 };
        }
        buffSeen[idStr].count++;

        const name = buffMap[idStr] ?? "(未映射)";

        // ===== STEP6：从 MAP 补状态（唯一来源）=====
        const key = `${entityUid}:${idStr}`;
        const s = global.__BUFF_STATE_MAP__?.get(key);
        if (s) {
            if (s.layer != null) ev.layer = s.layer;
            if (s.durationMs != null) ev.durationMs = s.durationMs;
        }
        // ===== 再算时间 =====
        const durUntil = (ev.durationMs && ev.durationMs > 0)
            ? Date.now() + ev.durationMs
            : 0;

        // ===== 再打日志 =====
        logger.buff(
            `[BUFF+] uid=${entityUid} buffId=${idStr} name=${name} ` +
            `slot=${ev.slot} dur=${((ev.durationMs ?? 0) / 1000).toFixed(1)}s ` +
            `durUntil=${durUntil} stack=${ev.layer ?? ev.stack ?? 1} op=${ev.opType}`
        );

        // ===== 再写入实例表 =====
        if (buffMap[idStr]) {
            let slots = activeSlotsById.get(idStr);
            if (!slots) {
                slots = new Map();
                activeSlotsById.set(idStr, slots);
            }

            const stack = ev.layer ?? ev.stack ?? 1;

            slots.set(ev.slot, {
                durUntil,
                cdUntil: 0,
                stack,
            });

            overlayWriter.setOne(idStr, {
                durUntil,
                cdUntil: 0,
                stack,
            });
            overlayDirty = true;
        }
    }

}
setInterval(() => {
    if (overlayDirty) {
        overlayWriter.flush();
        overlayDirty = false;

        // 推送给 overlay
        try { broadcastState(); } catch {}
    }
    saveJson(BUFF_SEEN_PATH, buffSeen);
}, 80);

function resetAllState(reason = "manual clear") {
    activeSlotsById.clear();
    slotLastBuffId.clear();
    overlayDirty = false;
    try { overlayWriter.resetAll(); }
    catch (e) { console.error("[resetAllState] writer.resetAll failed:", e?.message || e); }
}

module.exports = { onBuffEvent, resetAllState };

