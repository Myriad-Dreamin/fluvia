/**
 * The HTTP receiver: the other end of fluvia's `--notify dsh:http://…`.
 *
 * Three routes and no framework. `POST <path>` takes an envelope, `GET <path>`
 * returns the same status as JSON, and `GET /` returns the human page. A
 * plugin lives inside somebody else's long-running process, so the two
 * properties that matter more than features are: the handler never throws
 * (an unhandled rejection in a harness process is a crash, not a 500), and the
 * port is always released on unload (a plugin that leaks a listener makes the
 * next reload fail with EADDRINUSE).
 *
 * @module dsh-plugin-fluvia/receiver
 */
import { createServer } from 'node:http';
import { MAX_BODY_BYTES, parseEnvelope } from './envelope.js';
import { renderStatusJson, renderStatusPage } from './status-page.js';
/**
 * Bind the receiver.
 *
 * Rejects when the port cannot be bound, which is the correct loud failure: a
 * plugin whose endpoint silently is not listening looks exactly like a plugin
 * that works, right up until the operator wonders where their notifications
 * went.
 *
 * @param options — bind address, route, and the courier to feed.
 * @returns the bound receiver.
 * @throws {Error} when `listen` fails (a taken port, a refused interface).
 */
export function startReceiver(options) {
    const startedAt = Date.now();
    const server = createServer((request, response) => {
        // The handler is async and node:http does not await it, so an unhandled
        // rejection here would escape into the harness process. This catch is the
        // only thing standing between a malformed request and a process-level
        // crash, so it is unconditional and it answers rather than rethrows.
        handle(request, response, options, startedAt).catch((error) => {
            options.log.warn(`request handler failed: ${message(error)}`);
            trySend(response, 500, 'application/json', JSON.stringify({ ok: false, error: 'internal error' }));
        });
    });
    // Sockets held open by a keep-alive client would otherwise delay close().
    server.keepAliveTimeout = 5_000;
    server.headersTimeout = 10_000;
    return new Promise((resolve, reject) => {
        /** Bind-time failure: reported to the caller, which fails the plugin load. */
        const onBindError = (error) => reject(new Error(`cannot bind ${options.host}:${options.port} — ${error.message}`));
        server.once('error', onBindError);
        server.listen(options.port, options.host, () => {
            server.off('error', onBindError);
            // Post-bind errors are operational, not fatal: a dropped connection must
            // not take down the harness, so from here on they are logged only.
            server.on('error', (error) => options.log.warn(`server error: ${error.message}`));
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : options.port;
            resolve({
                port,
                close: async () => {
                    // closeAllConnections() first: close() alone waits for idle
                    // keep-alive sockets, which would stall a plugin reload.
                    server.closeAllConnections();
                    await new Promise((done) => server.close(() => done()));
                },
            });
        });
    });
}
/** Route one request. Every branch answers; none throws past the caller's catch. */
async function handle(request, response, options, startedAt) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname === options.path && request.method === 'POST') {
        await handlePost(request, response, options);
        return;
    }
    if (url.pathname === options.path && request.method === 'GET') {
        send(response, 200, 'application/json', renderStatusJson(view(options, startedAt)));
        return;
    }
    if (url.pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
        send(response, 200, 'text/html; charset=utf-8', renderStatusPage(view(options, startedAt)));
        return;
    }
    if (url.pathname === options.path || url.pathname === '/') {
        send(response, 405, 'application/json', JSON.stringify({ ok: false, error: `method ${request.method} not allowed` }));
        return;
    }
    send(response, 404, 'application/json', JSON.stringify({ ok: false, error: `no route for ${url.pathname}` }));
}
/**
 * Accept one envelope.
 *
 * Answers 202 rather than 200 and says so honestly: the envelope has been
 * handed to the courier, which either delivered it or is holding it, but the
 * model has not read anything yet and may not for a while. A malformed body is
 * 400 and is *not* retried by fluvia's sink; a courier-side problem is 500,
 * which the sink retries once.
 */
async function handlePost(request, response, options) {
    let body;
    try {
        body = await readBody(request);
    }
    catch (error) {
        send(response, 413, 'application/json', JSON.stringify({ ok: false, error: message(error) }));
        return;
    }
    let outcome;
    try {
        outcome = options.courier.accept(parseEnvelope(body));
    }
    catch (error) {
        options.log.warn(`rejected an envelope: ${message(error)}`);
        send(response, 400, 'application/json', JSON.stringify({ ok: false, error: message(error) }));
        return;
    }
    send(response, 202, 'application/json', JSON.stringify({ ok: outcome.kind !== 'failed', ...outcome }));
}
/** Assemble the current status view from config, courier counters, and the registry. */
function view(options, startedAt) {
    return {
        host: options.host,
        port: options.port,
        path: options.path,
        mode: options.mode,
        target: options.target,
        queueLimit: options.queueLimit,
        stats: options.courier.stats,
        liveAgents: options.courier.liveAgentIds(),
        targetAgents: options.courier.targetAgentIds(),
        startedAt,
    };
}
/**
 * Buffer a request body, refusing one that exceeds {@link MAX_BODY_BYTES}.
 *
 * Envelopes are small, so buffering is the honest implementation; the bound is
 * what keeps "small" from being an assumption. The request is destroyed rather
 * than drained on overflow, because continuing to read a body we have already
 * decided to reject is exactly the resource exhaustion the bound prevents.
 *
 * @param request — the incoming request.
 * @returns the body as UTF-8 text.
 * @throws {Error} when the body exceeds the bound or the socket errors.
 */
function readBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        let bytes = 0;
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_BODY_BYTES) {
                request.destroy();
                reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
                return;
            }
            body += chunk;
        });
        request.on('end', () => resolve(body));
        request.on('error', reject);
    });
}
/** Write one response. */
function send(response, status, type, body) {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(body);
}
/** Write one response, tolerating a socket that has already gone away. */
function trySend(response, status, type, body) {
    try {
        if (!response.headersSent)
            send(response, status, type, body);
        else
            response.end();
    }
    catch {
        // The client is gone. There is nobody left to tell.
    }
}
/** Normalize an unknown rejection into a readable message. */
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
