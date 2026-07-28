/**
 * Zero-dependency static development server.
 *
 * The library must be served over HTTP — opening index.html from the filesystem
 * fails because ES modules and the chart iframe are blocked on file:// origins.
 *
 *   node server.js            # http://localhost:5500
 *   node server.js 8080       # custom port
 *
 * 5500 is also VS Code Live Server's default port. That is deliberate — the
 * same address keeps working — but the two cannot run at once, and Live Server
 * cannot serve /api, so this one has to be the one holding the port.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasCredentials, loadEnv } from './server/env.js';
import { handleApi } from './server/routes.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 5500);

// Credentials come from .env, which is gitignored and never served.
loadEnv(ROOT);

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    res.end(body);
}

/**
 * Never served, whatever the URL says: secrets, server-side code, and the
 * instrument cache (33 MB of it).
 */
const PRIVATE_PATHS = [/^\.env/, /^server[\\/]/, /^data[\\/]/, /^node_modules[\\/]/];

const server = http.createServer(async (req, res) => {
    // WHATWG URL rather than the legacy url.parse; pathname stays
    // percent-encoded, which the decode below relies on.
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // API routes come first — they are not files on disk.
    try {
        if (await handleApi(req, res, url, ROOT)) return;
    } catch (error) {
        console.error('[server] unhandled API error:', error);
        send(res, 500, 'Internal error');
        return;
    }

    const decoded = decodeURIComponent(url.pathname);
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const filePath = path.join(ROOT, relative);

    // Refuse anything that escapes the project directory.
    if (!filePath.startsWith(ROOT + path.sep)) {
        send(res, 403, 'Forbidden');
        return;
    }

    const normalised = path.relative(ROOT, filePath);
    if (PRIVATE_PATHS.some((pattern) => pattern.test(normalised))) {
        send(res, 403, 'Forbidden');
        return;
    }

    fs.stat(filePath, (statErr, stats) => {
        if (statErr || !stats.isFile()) {
            send(res, 404, `Not found: ${relative}`);
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Content-Length': stats.size,
            // No caching in development so library and app edits show up at once.
            'Cache-Control': 'no-store',
        });
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`Serving ${ROOT}`);
    console.log(`→ http://localhost:${PORT}`);

    if (hasCredentials()) {
        console.log('Angel One: credentials loaded — /api/quote and /api/candles are live.');
    } else {
        console.log('');
        console.log('Angel One: no credentials, so NSE data endpoints return 503.');
        console.log('Copy .env.example to .env and set SMARTAPI_KEY, SMARTAPI_CLIENT_CODE,');
        console.log('SMARTAPI_PASSWORD and SMARTAPI_TOTP_SECRET. /api/search works without them.');
    }
});

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use.`);
        if (PORT === 5500) {
            // Overwhelmingly the cause: 5500 is Live Server's default too, and
            // it will happily serve index.html while 404ing every /api call.
            console.error('');
            console.error('5500 is also VS Code Live Server\'s port. If it is running, stop it');
            console.error('(click the "Port: 5500" item in the VS Code status bar) and try again —');
            console.error('Live Server cannot serve /api, so NSE panes will not load under it.');
        }
        console.error('');
        console.error(`Or pick another port: node server.js ${PORT + 1}`);
        process.exit(1);
    }
    throw error;
});
