/**
 * The little static server that puts the report in front of a browser.
 *
 * It exists because a `file://` page is a second-class citizen — some browsers
 * refuse it clipboard access, and a URL is easier to forward to a colleague
 * than a path — but it stays deliberately minimal: one document, held in
 * memory, bound to the loopback interface only. Nothing here reads the file
 * system at request time, so the running server cannot be talked into serving
 * anything except the report it was handed.
 *
 * @module fluvia/perf/serve
 */

import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'

/** A report server that is listening and ready to be shut down again. */
export interface ReportServer {
  /** The URL to print and to open. */
  url: string
  /** The port actually bound, which may not be the preferred one. */
  port: number
  /** Stop listening and drop any keep-alive connections. Idempotent. */
  close(): Promise<void>
}

/** Options for {@link serveReport}. */
export interface ServeOptions {
  /** First port to try. Subsequent ports are tried on `EADDRINUSE`. */
  port: number
  /** How many consecutive ports to try before giving up. */
  attempts?: number
  /** Interface to bind. Loopback only, by design. */
  host?: string
}

/**
 * Serve one HTML document on 127.0.0.1.
 *
 * The preferred port is often already taken by a previous run that is still
 * open in a browser tab, so the port is incremented until one binds rather
 * than failing: being told the new URL is friendlier than being told to go
 * find the old process.
 */
export function serveReport(html: string, options: ServeOptions): Promise<ReportServer> {
  const host = options.host ?? '127.0.0.1'
  const attempts = Math.max(1, options.attempts ?? 24)
  const body = Buffer.from(html, 'utf8')

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/index.html') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found\n')
      return
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.byteLength),
      // The report is regenerated on every run, so a cached copy is always the
      // wrong one; this is what makes a plain browser refresh pick up a rerun.
      'cache-control': 'no-store',
    })
    if (request.method === 'HEAD') response.end()
    else response.end(body)
  })

  return new Promise<ReportServer>((resolve, reject) => {
    let port = options.port
    let left = attempts

    const onError = (error: NodeJS.ErrnoException) => {
      if ((error.code === 'EADDRINUSE' || error.code === 'EACCES') && --left > 0) {
        port++
        server.listen(port, host)
        return
      }
      server.removeListener('error', onError)
      reject(error)
    }

    server.on('error', onError)
    server.once('listening', () => {
      server.removeListener('error', onError)
      const bound = server.address() as AddressInfo | null
      const actual = bound?.port ?? port
      resolve({
        url: `http://${host}:${actual}/`,
        port: actual,
        close: () =>
          new Promise<void>((done) => {
            // Browsers hold keep-alive sockets open; without dropping them the
            // close callback would never fire and Ctrl-C would appear to hang.
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      })
    })
    server.listen(port, host)
  })
}

/**
 * Ask the desktop to open a URL, and never let that failure matter.
 *
 * The child is detached and its stdio discarded so that a browser launched
 * here does not keep the terminal's pipes open, and every error path — no
 * `xdg-open`, a headless box, a non-zero exit — is swallowed: the URL was
 * already printed, so the user has what they need either way.
 *
 * @returns `true` if a launcher was spawned, `false` if it could not be.
 */
export function openBrowser(url: string): boolean {
  const launcher =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  try {
    const child = spawn(launcher, [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
