// buff_protobuf_def.js - 定义 field10 内部的 Buff 协议结构
const protobuf = require("protobufjs");

// 加载 Buff 嵌套结构的 Protobuf 定义（匹配游戏实际结构）
const root = protobuf.Root.fromJSON({
    nested: {
        BuffInfo: {
            fields: {
                type: { type: "int32", id: 1 }, // ADD=1, UPDATE=2, REMOVE=3
                slot: { type: "int32", id: 2 },
                ownerSlot: { type: "int32", id: 3 },
                buffId: { type: "int64", id: 4 }, // 注意：buffId 是 64 位
                stack: { type: "int32", id: 5 },
                durationMs: { type: "int32", id: 6 }
            }
        }
    }
});

// 导出 BuffInfo 解码类型
module.exports = {
    BuffInfo: root.lookupType("BuffInfo")
};