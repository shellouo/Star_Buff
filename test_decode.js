// test_decode.js - 验证你原有解析逻辑
const fs = require("fs");
// 引入你原有解析函数
const { decodeBuffField10 } = require("./buff/buff_decode_min");

// 找最新的dump文件
const dumpFiles = fs.readdirSync("./").filter(f => f.startsWith("dump_field10_") && f.endsWith(".bin"));
if (dumpFiles.length === 0) {
    console.error("❌ 先运行：$env:SR_DUMP_FIELD10='1'; node buff_monitor_cli.js live --dev 5 生成dump文件");
    process.exit(1);
}
const latestDumpFile = dumpFiles.sort().pop();
console.log("✅ 解析dump文件：", latestDumpFile);

// 读取并解析（用你原有逻辑）
const rawBytes = fs.readFileSync(latestDumpFile);
const buffEvents = decodeBuffField10(rawBytes);

// 打印结果
console.log("\n=== 解析结果 ===");
console.log("找到Buff事件数：", buffEvents.length);
buffEvents.forEach((ev, idx) => {
    if (ev.buffId > 0) {
        console.log(`\n事件${idx+1}：`);
        console.log(`  BuffID：${ev.buffId}`);
        console.log(`  持续时间：${ev.durationMs/1000}秒`);
        console.log(`  Slot：${ev.slot}`);
        console.log(`  所有者Slot：${ev.ownerSlot}`);
    }
});