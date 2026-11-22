/* socks5.mjs — a hand-written SOCKS5 client, and one small HTTP shim so an
 * outbound call can ride the tunnel. Zero dependencies: CONNECT is two fixed
 * request/reply pairs and then a socket, so a package would only add a parser
 * for bytes this file has to prove anyway (check-chat.mjs runs the handshake
 * against a stub).
 *
 * Deliberate limits, stated because they are the whole surface:
 *   - method 0x00 only (no auth). A route that answers 0x02 is refused with
 *     `auth` rather than half-negotiating.
 *   - ATYP domain (0x03) with the host exactly as given: the route resolves it,
 *     which is the point of routing by name. An IP literal is sent as a domain
 *     too — a resolver returns it unchanged.
 *   - one CONNECT per socket, no BIND, no UDP ASSOCIATE, no pipelining.
 *
 * A handshake failure rejects with a short reason (`greeting`, `auth`,
 * `connect`, `reply 0x05`, `timeout`) and `err.tunnel = true`, which is what
 * lets the hub tell "this route is broken" (mark it dead) apart from "the
 * upstream answered badly" (do not).
 */
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';

const SOCKS_VERSION = 0x05;
const METHOD_NO_AUTH = 0x00;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

function hex(n) {
  return Number(n).toString(16).padStart(2, '0');
}

/* A routing failure: the reason is the first two words, the detail is for the
 * log. `tunnel` is the flag the hub routes on. */
function tunnelFail(reason, detail) {
  const e = new Error(reason + (detail ? ': ' + detail : ''));
  e.reason = reason;
  e.tunnel = true;
  return e;
}

function connectRequest(host, port) {
  const name = Buffer.from(host, 'utf8');
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port, 0);
  return Buffer.concat([
    Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0x00, ATYP_DOMAIN, name.length]),
    name,
    portBytes,
  ]);
}

/* Resolves a connected socket tunnelled to host:port through route. The reply
 * is read in full before resolving, then parsing stops: any byte after it
 * belongs to the caller and is pushed back onto the socket. */
export function socks5Connect({ host, port, route, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const targetHost = String(host || '');
    const targetPort = Number(port);
    const via = route || {};
    if (!targetHost || !(targetPort > 0) || targetPort > 65535) {
      reject(tunnelFail('connect', 'no valid target host:port'));
      return;
    }
    if (Buffer.byteLength(targetHost, 'utf8') > 255) {
      reject(tunnelFail('connect', 'target host is longer than a SOCKS5 domain can carry'));
      return;
    }

    const sock = net.connect({ host: via.host, port: Number(via.port) });
    let buf = Buffer.alloc(0);
    let stage = 'greeting';          // greeting -> reply, then the socket is the caller's
    let settled = false;

    const timer = setTimeout(() => {
      fail(tunnelFail('timeout', 'no reply from the route in ' + timeoutMs + 'ms'));
    }, timeoutMs);

    function fail(e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    }

    function done() {
      settled = true;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onRouteError);
      sock.removeListener('close', onClose);
      sock.setNoDelay(true);
      sock.pause();                  // the consumer decides when it flows
      resolve(sock);
    }

    function onRouteError(e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const why = tunnelFail('connect', 'route ' + via.host + ':' + via.port
        + ' unreachable (' + ((e && e.code) || 'error') + ')');
      why.cause = e;
      reject(why);
    }

    function onClose() {
      fail(tunnelFail('greeting', 'the route closed the connection during the handshake'));
    }

    function onData(chunk) {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (settled) return;
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          if (buf[0] !== SOCKS_VERSION) {
            return fail(tunnelFail('greeting', 'not a SOCKS5 server (version ' + buf[0] + ')'));
          }
          if (buf[1] !== METHOD_NO_AUTH) {
            return fail(tunnelFail('auth', 'the route chose method 0x' + hex(buf[1])
              + '; this client offers only 0x00 (no auth)'));
          }
          buf = buf.subarray(2);
          stage = 'reply';
          sock.write(connectRequest(targetHost, targetPort));
          continue;
        }
        // stage === 'reply'
        if (buf.length < 4) return;
        if (buf[0] !== SOCKS_VERSION) {
          return fail(tunnelFail('reply 0x05', 'the reply was not SOCKS5 (version ' + buf[0] + ')'));
        }
        if (buf[1] !== 0x00) {
          return fail(tunnelFail('connect', 'the route refused CONNECT to ' + targetHost + ':'
            + targetPort + ' (reply 0x' + hex(buf[1]) + ')'));
        }
        let need;
        if (buf[3] === ATYP_IPV4) need = 4 + 4 + 2;
        else if (buf[3] === ATYP_IPV6) need = 4 + 16 + 2;
        else if (buf[3] === ATYP_DOMAIN) {
          if (buf.length < 5) return;
          need = 4 + 1 + buf[4] + 2;
        } else {
          return fail(tunnelFail('connect', 'the reply carried an unknown address type 0x' + hex(buf[3])));
        }
        if (buf.length < need) return;
        if (buf.length > need) sock.unshift(buf.subarray(need));
        buf = Buffer.alloc(0);
        done();
        return;
      }
    }

    sock.on('error', onRouteError);
    sock.on('close', onClose);
    sock.on('data', onData);
    sock.write(Buffer.from([SOCKS_VERSION, 0x01, METHOD_NO_AUTH]));
  });
}

/* The TLS handshake over a plain tunnel. SNI needs a name, not an address, so
 * an IP target is connected without a servername (and without a certificate
 * name to check — the caller chose the address). */
function secureOver(sock, host) {
  return new Promise((resolve, reject) => {
    const opts = { socket: sock };
    if (!net.isIP(host)) opts.servername = host;
    const t = tls.connect(opts, () => {
      t.removeListener('error', onErr);
      resolve(t);
    });
    // The tunnel arrives paused (no byte may be lost between the handshake and
    // the request); TLS cannot start until it flows again.
    sock.resume();
    function onErr(e) {
      t.removeListener('error', onErr);
      t.on('error', () => {});      // a dying socket can emit more than once
      e.tunnel = true;
      reject(e);
    }
    t.on('error', onErr);
  });
}

/* forward(origin, path, {method, headers, body, timeoutMs, route}) returns the
 * small surface the chat path already used: {status, ok, text(), headers.get()}.
 * With a route the request is written over a SOCKS5 tunnel; without one it is
 * the same fetch call the hub always made, so an unconfigured hub behaves
 * exactly as it did. Timeout destroys the socket, not just the promise.
 *
 * `agent: false` is the usual spelling for "one socket per request" — but Node
 * then builds a default Agent and never calls createConnection (probed on 18 and
 * 24). Leaving the agent unset is what actually routes: the provided
 * createConnection is used directly, nothing is pooled and a failed request can
 * never be retried onto a stale socket. */
export function forward(origin, path, opts = {}) {
  const url = new URL(origin + path);
  const timeoutMs = Number(opts.timeoutMs) || 30000;
  const method = opts.method || 'GET';
  const headers = opts.headers || {};
  const body = opts.body === undefined ? null : opts.body;
  const secure = url.protocol === 'https:';
  const host = url.hostname;
  const port = Number(url.port || (secure ? 443 : 80));
  const target = url.pathname + url.search;

  if (!opts.route) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const init = { method, headers, signal: ctrl.signal };
    if (body !== null) init.body = body;
    return fetch(url.toString(), init)
      .then((r) => ({
        status: r.status,
        ok: r.ok,
        headers: { get: (name) => r.headers.get(name) },
        text: () => r.text(),
      }))
      .finally(() => clearTimeout(timer));
  }

  return new Promise((resolve, reject) => {
    let sock = null;
    let settled = false;
    const timer = setTimeout(() => {
      const e = new Error('timed out after ' + timeoutMs + 'ms');
      e.name = 'AbortError';
      fail(e);
    }, timeoutMs);

    function fail(e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sock) sock.destroy();
      reject(e);
    }

    (async () => {
      try {
        sock = await socks5Connect({ host, port, route: opts.route, timeoutMs });
        // The request reports socket errors; this listener only keeps an error
        // that lands before the request adopts the socket from crashing the hub.
        sock.on('error', () => {});
        if (secure) {
          sock = await secureOver(sock, host);
          sock.on('error', () => {});
        }
      } catch (e) {
        fail(e);
        return;
      }
      if (settled) return;

      let req;
      try {
        req = (secure ? https : http).request({
          host,
          port,
          method,
          path: target,
          headers,
          createConnection: (options, cb) => cb(null, sock),
        });
      } catch (e) {
        fail(e);
        return;
      }
      req.on('error', fail);
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', fail);
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: {
              get: (name) => {
                const v = res.headers[String(name).toLowerCase()];
                return v === undefined ? null : v;
              },
            },
            text: () => Promise.resolve(Buffer.concat(chunks).toString('utf8')),
          });
        });
      });
      // The tunnel was handed over paused so the handshake could not leak a
      // byte; the request now owns the read side, so let it flow.
      sock.resume();
      req.end(body === null ? undefined : body);
    })();
  });
}