'use strict';

/**
 * 纯抓包版：只做
 * cap抓包 -> 选场景服务器 -> TCP重组 -> 切出 packetBytes -> onPacket(packetBytes)
 *
 * 不开网页，不用 cors / winston / express / socket.io
 * 不创建 PacketProcessor，不做 DPS
 */

const cap = safeRequireCap();
const { Readable } = require('stream');

const Cap = cap.Cap;
const decoders = cap.decoders;
const PROTOCOL = decoders.PROTOCOL;

function warnAndExit(text) {
    console.log(`\x1b[31m${text}\x1b[0m`);
    try { require('fs').readSync(0, Buffer.alloc(1), 0, 1, null); } catch {}
    process.exit(1);
}

function safeRequireCap() {
    try {
        return require('cap');
    } catch (e) {
        console.error(e);
        warnAndExit(
            'Failed to load the PCAP module. Please verify Npcap/WinPcap is installed and cap deps are installed.',
        );
    }
}

class Lock {
    constructor() {
        this.queue = [];
        this.locked = false;
    }
    async acquire() {
        if (this.locked) return new Promise((resolve) => this.queue.push(resolve));
        this.locked = true;
    }
    release() {
        if (this.queue.length > 0) this.queue.shift()();
        else this.locked = false;
    }
}

/**
 * @param {object} opt
 * @param {string} opt.device cap.deviceList()[i].name
 * @param {Console} [opt.logger]
 * @param {(packetBytes:Buffer)=>void} opt.onPacket
 * @param {(serverKey:string)=>void} [opt.onServerChange]
 * @returns {{ stop:()=>void, reset:(reason?:string)=>void }}
 */
function startServerCapture({ device, logger = console, onPacket, onServerChange } = {}) {
    if (!device) throw new Error('startServerCapture: device is required');
    if (typeof onPacket !== 'function') throw new Error('startServerCapture: onPacket is required');

    logger.info('[cap] capture start (pure capture)');

    let current_server = '';
    let _data = Buffer.alloc(0);
    let tcp_next_seq = -1;
    let tcp_cache = new Map();
    let tcp_last_time = 0;
    const tcp_lock = new Lock();

    const clearTcpCache = () => {
        _data = Buffer.alloc(0);
        tcp_next_seq = -1;
        tcp_last_time = 0;
        tcp_cache.clear();
    };

    // ===== IP 分片重组（原 server.js 同款逻辑）=====
    const fragmentIpCache = new Map();
    const FRAGMENT_TIMEOUT = 30000;

    const getTCPPacket = (frameBuffer, ethOffset) => {
        const ipPacket = decoders.IPV4(frameBuffer, ethOffset);
        const ipId = ipPacket.info.id;
        const isFragment = (ipPacket.info.flags & 0x1) !== 0;
        const _key = `${ipId}-${ipPacket.info.srcaddr}-${ipPacket.info.dstaddr}-${ipPacket.info.protocol}`;
        const now = Date.now();

        if (isFragment || ipPacket.info.fragoffset > 0) {
            if (!fragmentIpCache.has(_key)) {
                fragmentIpCache.set(_key, { fragments: [], timestamp: now });
            }

            const cacheEntry = fragmentIpCache.get(_key);
            const ipBuffer = Buffer.from(frameBuffer.subarray(ethOffset));
            cacheEntry.fragments.push(ipBuffer);
            cacheEntry.timestamp = now;

            // 还有更多分片
            if (isFragment) return null;

            // 最后一片来了，重组
            const fragments = cacheEntry.fragments;
            if (!fragments) {
                logger.error(`Can't find fragments for ${_key}`);
                return null;
            }

            let totalLength = 0;
            const fragmentData = [];

            for (const buffer of fragments) {
                const ip = decoders.IPV4(buffer);
                const fragmentOffset = ip.info.fragoffset * 8;
                const payloadLength = ip.info.totallen - ip.hdrlen;
                const payload = Buffer.from(buffer.subarray(ip.offset, ip.offset + payloadLength));
                fragmentData.push({ offset: fragmentOffset, payload });

                const endOffset = fragmentOffset + payloadLength;
                if (endOffset > totalLength) totalLength = endOffset;
            }

            const fullPayload = Buffer.alloc(totalLength);
            for (const fragment of fragmentData) fragment.payload.copy(fullPayload, fragment.offset);

            fragmentIpCache.delete(_key);
            return fullPayload;
        }

        return Buffer.from(
            frameBuffer.subarray(
                ipPacket.offset,
                ipPacket.offset + (ipPacket.info.totallen - ipPacket.hdrlen),
            ),
        );
    };

    // ===== Cap 初始化 =====
    const eth_queue = [];
    const c = new Cap();
    const filter = 'ip and tcp';
    const bufSize = 10 * 1024 * 1024;
    const buffer = Buffer.alloc(65535);

    const linkType = c.open(device, filter, bufSize, buffer);
    const supportedLinkType = ['ETHERNET', 'NULL', 'LINKTYPE_LINUX_SLL'];
    if (!supportedLinkType.includes(linkType)) {
        logger.error('[cap] device linkType not supported: ' + linkType);
    }
    c.setMinBytes && c.setMinBytes(0);

    c.on('packet', function (nbytes) {
        eth_queue.push(Buffer.from(buffer.subarray(0, nbytes)));
    });

    const processEthPacket = async (frameBuffer) => {
        let ethPacket;
        if (linkType === 'ETHERNET') {
            ethPacket = decoders.Ethernet(frameBuffer);
        } else if (linkType === 'NULL') {
            ethPacket = {
                info: {
                    type: frameBuffer.readUInt32LE() === 2 ? 2048 : 75219598273637n,
                },
                offset: 4,
            };
        } else if (linkType === 'LINKTYPE_LINUX_SLL') {
            ethPacket = {
                info: {
                    type: frameBuffer.readUInt32BE(14) === 0x0800 ? 2048 : 75219598273637n,
                },
                offset: 16,
            };
        } else {
            return;
        }

        if (ethPacket.info.type !== PROTOCOL.ETHERNET.IPV4) return;

        const ipPacket = decoders.IPV4(frameBuffer, ethPacket.offset);
        const srcaddr = ipPacket.info.srcaddr;
        const dstaddr = ipPacket.info.dstaddr;

        const tcpBuffer = getTCPPacket(frameBuffer, ethPacket.offset);
        if (tcpBuffer === null) return;

        const tcpPacket = decoders.TCP(tcpBuffer);
        const buf = Buffer.from(tcpBuffer.subarray(tcpPacket.hdrlen));
        if (!buf.length) return;

        const srcport = tcpPacket.info.srcport;
        const dstport = tcpPacket.info.dstport;

        const src_server = `${srcaddr}:${srcport} -> ${dstaddr}:${dstport}`;
        const src_server_re = `${dstaddr}:${dstport} -> ${srcaddr}:${srcport}`;

        await tcp_lock.acquire();

        // ===== 选场景服务器（原 server.js 同款三段识别）=====
        if (current_server !== src_server && current_server !== src_server_re) {
            try {
                // FrameDown Notify
                if (buf[4] == 0 && buf[5] == 6) {
                    const data = buf.subarray(10);
                    if (data.length) {
                        const stream = Readable.from(data, { objectMode: false });
                        let data1;
                        do {
                            const len_buf = stream.read(4);
                            if (!len_buf) break;
                            data1 = stream.read(len_buf.readUInt32BE() - 4);
                            const signature = Buffer.from([0x00, 0x63, 0x33, 0x53, 0x42, 0x00]); // c3SB??
                            if (Buffer.compare(data1.subarray(5, 5 + signature.length), signature)) break;

                            if (current_server !== src_server) {
                                current_server = src_server;
                                clearTcpCache();
                                tcp_next_seq = (tcpPacket.info.seqno + buf.length) >>> 0;
                                onServerChange && onServerChange(current_server);
                                logger.info('[cap] Got Scene Server by FrameDown: ' + src_server);
                            }
                        } while (data1 && data1.length);
                    }
                }
            } catch {}

            try {
                // Login Return
                if (buf.length === 0x62) {
                    const signature = Buffer.from([
                        0x00, 0x00, 0x00, 0x62,
                        0x00, 0x03,
                        0x00, 0x00, 0x00, 0x01,
                        0x00, 0x11, 0x45, 0x14,
                        0x00, 0x00, 0x00, 0x00,
                        0x0a, 0x4e, 0x08, 0x01, 0x22, 0x24
                    ]);
                    if (
                        Buffer.compare(buf.subarray(0, 10), signature.subarray(0, 10)) === 0 &&
                        Buffer.compare(buf.subarray(14, 14 + 6), signature.subarray(14, 14 + 6)) === 0
                    ) {
                        if (current_server !== src_server) {
                            current_server = src_server;
                            clearTcpCache();
                            tcp_next_seq = (tcpPacket.info.seqno + buf.length) >>> 0;
                            onServerChange && onServerChange(current_server);
                            logger.info('[cap] Got Scene Server by LoginReturn: ' + src_server);
                        }
                    }
                }
            } catch {}

            try {
                // FrameUp Notify
                if (buf[4] == 0 && buf[5] == 5) {
                    const data = buf.subarray(10);
                    if (data.length) {
                        const stream = Readable.from(data, { objectMode: false });
                        let data1;
                        do {
                            const len_buf = stream.read(4);
                            if (!len_buf) break;
                            data1 = stream.read(len_buf.readUInt32BE() - 4);
                            const signature = Buffer.from([0x00, 0x06, 0x26, 0xad, 0x66, 0x00]);
                            if (Buffer.compare(data1.subarray(5, 5 + signature.length), signature)) break;

                            if (current_server !== src_server_re) {
                                current_server = src_server_re;
                                clearTcpCache();
                                tcp_next_seq = (tcpPacket.info.ackno) >>> 0;
                                onServerChange && onServerChange(current_server);
                                logger.info('[cap] Got Scene Server by FrameUp: ' + src_server_re);
                            }
                        } while (data1 && data1.length);
                    }
                }
            } catch {}

            tcp_lock.release();
            return;
        }

        // ===== TCP 重组 =====
        if (tcp_next_seq === -1) {
            // 兜底：尝试从当前包同步一个 seq
            if (buf.length > 4 && buf.readUInt32BE() < 0x0fffff) {
                tcp_next_seq = tcpPacket.info.seqno >>> 0;
            } else {
                tcp_lock.release();
                return;
            }
        }

        if ((((tcp_next_seq - tcpPacket.info.seqno) << 0) <= 0) || tcp_next_seq === -1) {
            tcp_cache.set(tcpPacket.info.seqno >>> 0, buf);
        }

        while (tcp_cache.has(tcp_next_seq)) {
            const seq = tcp_next_seq;
            const cachedTcpData = tcp_cache.get(seq);
            _data = _data.length === 0 ? cachedTcpData : Buffer.concat([_data, cachedTcpData]);
            tcp_next_seq = (seq + cachedTcpData.length) >>> 0;
            tcp_cache.delete(seq);
            tcp_last_time = Date.now();
        }

        // ===== 切 packetBytes（关键输出）=====
        while (_data.length > 4) {
            const packetSize = _data.readUInt32BE();
            if (_data.length < packetSize) break;

            const packet = _data.subarray(0, packetSize);
            _data = _data.subarray(packetSize);

            try { onPacket(packet); }
            catch (e) { logger.error('[cap] onPacket error: ' + (e?.message || e)); }
        }

        tcp_lock.release();
    };

    let running = true;

    (async () => {
        while (running) {
            if (eth_queue.length) {
                const pkt = eth_queue.shift();
                // 不 await 也行；保持与你原作者一致的“吞吐优先”
                processEthPacket(pkt);
            } else {
                await new Promise((r) => setTimeout(r, 1));
            }
        }
    })();

    // 定时清理分片缓存 + TCP 超时复位
    const timer = setInterval(() => {
        const now = Date.now();
        let clearedFragments = 0;
        for (const [key, cacheEntry] of fragmentIpCache) {
            if (now - cacheEntry.timestamp > FRAGMENT_TIMEOUT) {
                fragmentIpCache.delete(key);
                clearedFragments++;
            }
        }
        if (clearedFragments > 0) {
            logger.debug && logger.debug(`[cap] Cleared ${clearedFragments} expired IP fragment caches`);
        }

        if (tcp_last_time && Date.now() - tcp_last_time > FRAGMENT_TIMEOUT) {
            logger.warn('[cap] reassembly stalled, reset scene server');
            current_server = '';
            clearTcpCache();
        }
    }, 10000);

    return {
        stop() {
            running = false;
            clearInterval(timer);
            try { c.close(); } catch {}
            logger.info('[cap] stopped');
        },
        reset(reason = 'manual') {
            logger.warn('[cap] reset: ' + reason);
            current_server = '';
            clearTcpCache();
        },
    };
}

module.exports = { startServerCapture };
