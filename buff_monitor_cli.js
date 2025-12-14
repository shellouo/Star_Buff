// buff_monitor_cli.js
const path = require("path");
const fs = require("fs");

const { listDevices, resolveDevice, startCapture } = require("./capture_core");
const { SRPacketParser } = require("./protocol/sr_packet");

const { decodeBuffField10 } = require("./buff/buff_decode_min");
const { BuffState } = require("./buff/buff_state");

// ==================================================
// AOI field10 全局 hook（由 sr_blueprotobuf.js 的 case10 触发）
// ==================================================
global.__SR_ON_AOI_FIELD10__ = (field10Bytes) => {
  handleField10(field10Bytes, global.__SR_DUMPDIR__ || null);
};


function printHelp() {
  console.log(`
Usage:
  node buff_monitor_cli.js list
  node buff_monitor_cli.js live --dev <index|name|keyword> [--dumpdir <dir>]
  node buff_monitor_cli.js replay <file.bin>

Examples:
  node buff_monitor_cli.js list
  node buff_monitor_cli.js live --dev 3
  node buff_monitor_cli.js live --dev "Realtek" --dumpdir ./dumps
  node buff_monitor_cli.js replay dump_field10_123.bin
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      args[k] = v;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const cmd = args._[0];

const state = new BuffState({
  icdConfig: {
    // 例：2205391: 30000,
  }
});

function handleField10(field10Bytes, dumpdir) {
  // 可选：dump 调试（默认不写）
  if (dumpdir) {
    fs.mkdirSync(dumpdir, { recursive: true });
    const name = `dump_field10_${Date.now()}.bin`;
    fs.writeFileSync(path.join(dumpdir, name), Buffer.from(field10Bytes));
  }

  const events = decodeBuffField10(field10Bytes);
  state.feedBuffEvents(events);

  for (const e of events) {
    if (e.buffId != null) {
      console.log(`[BUFF] slot=${e.slot} owner=${e.ownerSlot} buffId=${e.buffId} stack=${e.stack} dur=${e.durationMs}`);
    } else {
      // 没 buffId 的，通常是 remove/clear/占位事件
      console.log(`[BUFF] slot=${e.slot} (no buffId)`);
    }
  }

  const lines = state.getIcdLines?.();
  if (lines && lines.length) console.log(lines.join("\n"));
}

if (!cmd || cmd === "help") {
  printHelp();
  process.exit(0);
}

if (cmd === "list") {
  const devs = listDevices();
  devs.forEach(d => {
    console.log(`[${d.index}] ${d.name} | ${d.description} | ${d.addresses.join(",")}`);
  });
  process.exit(0);
}

if (cmd === "replay") {
  const file = args._[1];
  if (!file) return printHelp();
  const buf = fs.readFileSync(file);
  handleField10(buf, null);
  process.exit(0);
}

if (cmd === "live") {
  const devName = resolveDevice(args.dev);
  if (!devName) {
    console.error("Device not found. Use: node buff_monitor_cli.js list");
    process.exit(1);
  }

  // ⭐ 把 dumpdir 交给全局 hook（默认 null 就是不落盘）
  global.__SR_DUMPDIR__ = args.dumpdir || null;

  // ⭐ SRPacketParser 只负责喂包；Buff 由 sr_blueprotobuf.js 的 case10 -> global hook 处理
  const parser = new SRPacketParser();

  console.log("Capturing on:", devName);

  const capHandle = startCapture({
    device: devName,
    onPacket(packetBytes) {
      parser.feedPacket(packetBytes);
    }
  });

  process.on("SIGINT", () => {
    console.log("Stopping...");
    capHandle.stop();
    process.exit(0);
  });

  return;
}

printHelp();
