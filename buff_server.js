// buff_server.js
const { decodeBuffField10 } = require('./buff_decode_min');
const { BuffState } = require('./buff_state');
const { listDevices, resolveDevice, startLive } = require('./capture_core');

const state = new BuffState({
    icdConfig: {
        // 例：2205391: 30000,
    },
});

function onField10Payload(field10Bytes) {
    const events = decodeBuffField10(field10Bytes);
    state.feedBuffEvents(events);

    for (const e of events) {
        if (e.buffId == null) continue;
        console.log(`[BUFF] slot=${e.slot} owner=${e.ownerSlot} buffId=${e.buffId} stack=${e.stack} dur=${e.durationMs}`);
    }

    const lines = state.getIcdLines();
    if (lines && lines.length) console.log(lines.join('\n'));
}

// ✅ 关键：把 AOI case10 里抛出的 bytes 接到这里
globalThis.__onAoiField10 = onField10Payload;

const args = process.argv.slice(2);

if (args[0] === '--list') {
    const devs = listDevices();
    devs.forEach((d) => {
        console.log(`[${d.index}] ${d.name} | ${d.description} | ${d.addresses.join(', ')}`);
    });
    process.exit(0);
}

if (args[0] === '--live') {
    const devName = resolveDevice(args[1]);
    if (!devName) {
        console.error('Device not found. Run: node buff_server.js --list');
        process.exit(1);
    }
    console.log('[LIVE] using device:', devName);
    startLive({ device: devName, logger: console });
    console.log('[LIVE] running... (Ctrl+C to stop)');
    return;
}

console.log(
    'Usage:\n' +
        '  node buff_server.js --list\n' +
        '  node buff_server.js --live <index>\n' +
        '  node buff_server.js --live "<namePart>"\n',
);
