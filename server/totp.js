/**
 * RFC 6238 time-based one-time passwords, on top of node:crypto.
 *
 * SmartAPI's login requires the current TOTP from the authenticator secret you
 * registered, so the server has to generate it rather than a human typing it.
 * Verified against the RFC 6238 test vectors in test/totp.test.mjs.
 */

import crypto from 'node:crypto';

/** Decodes RFC 4648 base32 (the format authenticator apps show). */
export function base32Decode(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');

    let bits = 0;
    let value = 0;
    const bytes = [];

    for (const char of clean) {
        const index = alphabet.indexOf(char);
        if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((value >>> bits) & 0xff);
        }
    }

    return Buffer.from(bytes);
}

/**
 * @param {string|Buffer} secret     Base32 string, or raw key bytes.
 * @param {object} [options]
 * @param {number} [options.time]    Unix seconds. Defaults to now.
 * @param {number} [options.step]    Window length in seconds.
 * @param {number} [options.digits]  Code length.
 * @param {string} [options.algorithm]
 * @returns {string} Zero-padded code.
 */
export function totp(secret, { time = Date.now() / 1000, step = 30, digits = 6, algorithm = 'sha1' } = {}) {
    const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
    const counter = Math.floor(time / step);

    // 8-byte big-endian counter.
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(counter));

    const digest = crypto.createHmac(algorithm, key).update(message).digest();

    // Dynamic truncation (RFC 4226 §5.4).
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);

    return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Seconds until the current code expires — useful for retry timing. */
export function secondsRemaining(step = 30, time = Date.now() / 1000) {
    return step - Math.floor(time % step);
}
