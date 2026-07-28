/**
 * RFC 6238 test vectors. If these pass, SmartAPI login failures are credential
 * or clock problems, not a broken code generator.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

const { totp, base32Decode, secondsRemaining } = await import(
    new URL('../server/totp.js', import.meta.url).href
);

// RFC 6238 uses the ASCII secret "12345678901234567890".
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('base32 decodes to the RFC secret', () => {
    assert.equal(base32Decode(RFC_SECRET_BASE32).toString('ascii'), '12345678901234567890');
});

test('base32 tolerates lowercase, spaces and padding', () => {
    assert.equal(
        base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq===').toString('ascii'),
        '12345678901234567890',
    );
});

test('base32 rejects invalid characters', () => {
    assert.throws(() => base32Decode('ABC1!'), /Invalid base32/);
});

test('RFC 6238 SHA-1 vectors (8 digits)', () => {
    const vectors = [
        [59, '94287082'],
        [1111111109, '07081804'],
        [1111111111, '14050471'],
        [1234567890, '89005924'],
        [2000000000, '69279037'],
        [20000000000, '65353130'],
    ];
    for (const [time, expected] of vectors) {
        assert.equal(
            totp(RFC_SECRET_BASE32, { time, digits: 8 }),
            expected,
            `T=${time}`,
        );
    }
});

test('produces a zero-padded 6-digit code by default', () => {
    const code = totp(RFC_SECRET_BASE32, { time: 59 });
    assert.match(code, /^\d{6}$/);
    // Same truncation as the 8-digit vector, last six digits.
    assert.equal(code, '287082');
});

test('code is stable inside a step and changes across it', () => {
    // Windows are aligned to multiples of the step, not to the times you pick:
    // counter 34 covers t = 1020..1049 inclusive.
    const start = totp(RFC_SECRET_BASE32, { time: 1020 });
    const end = totp(RFC_SECRET_BASE32, { time: 1049 });
    const next = totp(RFC_SECRET_BASE32, { time: 1050 });
    assert.equal(start, end, 'same 30s window');
    assert.notEqual(start, next, 'next window');
});

test('accepts a raw key buffer as well as base32', () => {
    assert.equal(
        totp(Buffer.from('12345678901234567890', 'ascii'), { time: 59, digits: 8 }),
        '94287082',
    );
});

test('secondsRemaining counts down to the window boundary', () => {
    assert.equal(secondsRemaining(30, 1020), 30, 'start of window 34');
    assert.equal(secondsRemaining(30, 1029), 21);
    assert.equal(secondsRemaining(30, 1049), 1, 'last second of window 34');
    assert.equal(secondsRemaining(30, 1050), 30, 'start of window 35');
});
