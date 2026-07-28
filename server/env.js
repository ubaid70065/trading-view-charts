/**
 * Minimal .env loader — no dependency, no magic.
 *
 * Credentials never appear in source or in anything the browser can fetch.
 * Real environment variables win over the file, so deployments can override.
 */

import fs from 'node:fs';
import path from 'node:path';

let loaded = false;

export function loadEnv(root) {
    if (loaded) return;
    loaded = true;

    const file = path.join(root, '.env');
    if (!fs.existsSync(file)) return;

    for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const eq = line.indexOf('=');
        if (eq === -1) continue;

        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();

        // Strip one layer of matching quotes, so secrets with # or spaces survive.
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        if (process.env[key] === undefined) process.env[key] = value;
    }
}

/** Reads a required variable, failing loudly rather than half-working. */
export function required(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(
            `${name} is not set. Copy .env.example to .env and fill it in — ` +
            'see the "NSE data" section of README.md.',
        );
    }
    return value;
}

export function optional(name, fallback) {
    return process.env[name] || fallback;
}

/** True when every credential needed to log in is present. */
export function hasCredentials() {
    return Boolean(
        process.env.SMARTAPI_KEY &&
        process.env.SMARTAPI_CLIENT_CODE &&
        process.env.SMARTAPI_PASSWORD &&
        process.env.SMARTAPI_TOTP_SECRET,
    );
}
