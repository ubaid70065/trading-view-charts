/**
 * Minimal RFC 6455 WebSocket client, text frames only.
 *
 * Node 22+ ships a global `WebSocket`, and this module would not exist if that
 * one were usable here. It is spec-compliant, and the spec deliberately forbids
 * setting `Origin` from script — the browser owns that header. TradingView's
 * edge rejects any upgrade whose `Origin` it does not recognise, so a request
 * that cannot set the header gets a bare TCP close (1006) with no explanation.
 * Hence a hand-rolled client over `node:tls`, which owns its own request line.
 *
 * The `ws` package would also do it, but this project vendors rather than
 * depends — `package.json` has no dependencies and the server is pure stdlib.
 * The subset needed here is small: no extensions, no binary frames, no
 * client-side fragmentation.
 *
 * Deliberately *not* negotiated: `permessage-deflate`. TradingView offers it,
 * and accepting it would mean carrying an inflate context across frames. The
 * feed is a few KB/s of JSON, so the compression is not worth the state.
 */

import tls from 'node:tls';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** GUID from RFC 6455 §1.3, used to derive the handshake response. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** A server frame larger than this is treated as a protocol fault, not data. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/**
 * @fires open
 * @fires message  (text: string)
 * @fires error    (error: Error)
 * @fires close
 */
export class WebSocketClient extends EventEmitter {
    /**
     * @param {string} url            wss:// only — this talks to one host.
     * @param {object} [options]
     * @param {string} [options.origin]      Sent verbatim as the Origin header.
     * @param {string} [options.userAgent]
     * @param {number} [options.timeout]         Idle socket timeout, ms.
     * @param {number} [options.connectTimeout]  Ceiling on the handshake, ms.
     * @param {string} [options.address]  Dial this IP instead of resolving the
     *   host. TLS and Host still use the hostname, so the peer cannot tell.
     */
    constructor(url, {
        origin, userAgent, timeout = 30000, connectTimeout = 8000, address,
    } = {}) {
        super();
        this.url = new URL(url);
        if (this.url.protocol !== 'wss:') throw new Error('Only wss:// is supported');

        this._origin = origin;
        this._userAgent = userAgent
            || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
             + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
        this._timeout = timeout;
        this._connectTimeout = connectTimeout;
        this._address = address;

        /** The peer actually reached, once connected. */
        this.remoteAddress = null;
        this._socket = null;
        this._buffer = Buffer.alloc(0);
        this._upgraded = false;
        /** Continuation frames accumulate here until the FIN bit arrives. */
        this._fragments = [];
        this.closed = false;
    }

    connect() {
        const host = this.url.hostname;
        const key = crypto.randomBytes(16).toString('base64');
        this._expectedAccept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

        this._socket = tls.connect({
            host: this._address || host,
            port: Number(this.url.port) || 443,
            // SNI and certificate validation follow the name, never the dialled
            // address, so pinning an IP does not weaken the TLS check.
            servername: host,
            // Without this the server may pick h2, which speaks no Upgrade.
            ALPNProtocols: ['http/1.1'],
        });
        // A short leash until the upgrade lands, then the longer idle one.
        // `widgetdata.tradingview.com` resolves to a rotating pool and some
        // nodes accept the TCP connection but never answer, so waiting the full
        // idle timeout on a dead one would stall every caller behind it.
        this._socket.setTimeout(this._connectTimeout);
        this._handshakeTimer = setTimeout(
            () => this._fail('handshake timed out'),
            this._connectTimeout,
        );

        this._socket.on('secureConnect', () => {
            this._socket.write([
                `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
                `Host: ${host}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Key: ${key}`,
                'Sec-WebSocket-Version: 13',
                ...(this._origin ? [`Origin: ${this._origin}`] : []),
                `User-Agent: ${this._userAgent}`,
                'Accept-Language: en-US,en;q=0.9',
                '',
                '',
            ].join('\r\n'));
        });

        this._socket.on('data', (chunk) => this._onData(chunk));
        this._socket.on('timeout', () => this._fail('socket idle timeout'));
        this._socket.on('error', (error) => this._fail(error.message));
        this._socket.on('close', () => this._finish());

        return this;
    }

    send(text) {
        if (this.closed || !this._upgraded) return false;
        this._writeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
        return true;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try {
            this._writeFrame(OP_CLOSE, Buffer.alloc(0));
            this._socket?.end();
        } catch {
            // Already gone; _finish still has to run.
        }
        this._finish();
    }

    /* ------------------------------------------------------------- internals */

    _fail(message) {
        if (this.closed) return;
        this.closed = true;
        this.emit('error', new Error(message));
        this._socket?.destroy();
        this._finish();
    }

    _finish() {
        if (this._done) return;
        this._done = true;
        this.closed = true;
        clearTimeout(this._handshakeTimer);
        this.emit('close');
    }

    _onData(chunk) {
        this._buffer = Buffer.concat([this._buffer, chunk]);

        if (!this._upgraded) {
            const end = this._buffer.indexOf('\r\n\r\n');
            // Headers still arriving.
            if (end === -1) return;

            const head = this._buffer.subarray(0, end).toString('latin1');
            const status = head.split('\r\n')[0];

            if (!/^HTTP\/1\.1 101/.test(status)) {
                this._fail(`handshake rejected: ${status}`);
                return;
            }
            // Proves the response came from a WebSocket peer rather than a proxy
            // that happened to answer 101.
            const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
            if (accept !== this._expectedAccept) {
                this._fail('handshake failed: bad Sec-WebSocket-Accept');
                return;
            }

            this._buffer = this._buffer.subarray(end + 4);
            this._upgraded = true;
            this.remoteAddress = this._socket.remoteAddress;
            clearTimeout(this._handshakeTimer);
            // The feed is quiet between heartbeats, so relax the leash now that
            // the peer has proved it is answering.
            this._socket.setTimeout(this._timeout);
            this.emit('open');
        }

        this._drain();
    }

    _drain() {
        for (;;) {
            const frame = this._readFrame();
            if (!frame) return;

            switch (frame.opcode) {
                case OP_CLOSE:
                    this.close();
                    return;
                case OP_PING:
                    this._writeFrame(OP_PONG, frame.payload);
                    continue;
                case OP_PONG:
                    continue;
                default:
                    break;
            }

            if (frame.opcode === OP_CONTINUATION) this._fragments.push(frame.payload);
            else this._fragments = [frame.payload];

            if (frame.fin) {
                const message = Buffer.concat(this._fragments).toString('utf8');
                this._fragments = [];
                this.emit('message', message);
            }
        }
    }

    /** @returns {{fin: boolean, opcode: number, payload: Buffer}|null} null when incomplete. */
    _readFrame() {
        const buffer = this._buffer;
        if (buffer.length < 2) return null;

        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;

        // A masked server frame is a protocol violation (RFC 6455 §5.1).
        if ((buffer[1] & 0x80) !== 0) {
            this._fail('server sent a masked frame');
            return null;
        }

        let length = buffer[1] & 0x7f;
        let offset = 2;

        if (length === 126) {
            if (buffer.length < 4) return null;
            length = buffer.readUInt16BE(2);
            offset = 4;
        } else if (length === 127) {
            if (buffer.length < 10) return null;
            const big = buffer.readBigUInt64BE(2);
            if (big > BigInt(MAX_FRAME_BYTES)) {
                this._fail('frame exceeds the size limit');
                return null;
            }
            length = Number(big);
            offset = 10;
        }

        if (buffer.length < offset + length) return null;

        const payload = buffer.subarray(offset, offset + length);
        this._buffer = buffer.subarray(offset + length);
        return { fin, opcode, payload };
    }

    /** Client frames must be masked with a fresh key (RFC 6455 §5.3). */
    _writeFrame(opcode, payload) {
        const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
        const length = data.length;

        let header;
        if (length < 126) {
            header = Buffer.alloc(2);
            header[1] = 0x80 | length;
        } else if (length < 65536) {
            header = Buffer.alloc(4);
            header[1] = 0x80 | 126;
            header.writeUInt16BE(length, 2);
        } else {
            header = Buffer.alloc(10);
            header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(length), 2);
        }
        header[0] = 0x80 | opcode;

        const mask = crypto.randomBytes(4);
        const masked = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i++) masked[i] = data[i] ^ mask[i & 3];

        this._socket.write(Buffer.concat([header, mask, masked]));
    }
}
