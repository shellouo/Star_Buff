// writer.js
const fs = require("fs");

function createWriter({ outPath = "./state.json" } = {}) {
    const state = Object.create(null);

    function setOne(id, v) {
        const s = state[id] || (state[id] = {});
        if ("durUntil" in v) s.durUntil = (v.durUntil ?? 0);
        if ("cdUntil"  in v) s.cdUntil  = (v.cdUntil  ?? 0);
        if ("stack"    in v) s.stack    = (v.stack    ?? 0);
    }
    function resetAll() {
        for (const k of Object.keys(state)) delete state[k];
        fs.writeFileSync(outPath, "{}", "utf8");
    }

    function flush() {
        const now = Date.now();


        // ✅ 兜底清理：durUntil 到期且 cd 不在跑 → 删除 key
        for (const [id, v] of Object.entries(state)) {
            if (!v || typeof v !== "object") { delete state[id]; continue; }

            const durUntil = v.durUntil ?? 0;
            const cdUntil  = v.cdUntil  ?? 0;

            const durDead = durUntil > 0 && durUntil <= now;
            const cdAlive = cdUntil > now;

            // ✅ 关键：durUntil===0 不再自动删除（只靠 BUFF- 删除）
            if (durDead && !cdAlive) delete state[id];
        }

        fs.writeFileSync(outPath, JSON.stringify(state, null, 2), "utf8");
    }


    function delOne(id) {
        if (id in state) delete state[id];
    }


    return { state, setOne, delOne, flush };
}

module.exports = { createWriter };
