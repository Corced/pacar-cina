/* ws.mjs — the smallest useful WebSocket *server* (RFC 6455), no dependencies.
 *
 * Why hand-rolled: the project has no dependencies on purpose, and the protocol
 * is small enough to read. The browser-side client is built in, so the hub only
 * needs the server half.
 *
 * What is implemented: the handshake (SHA-1 accept), text/binary frames,
 * fragmentation, ping/pong, close. What is NOT: extensions, and compression
 * (permessage-deflate is never negotiated — the client only uses it if we say
 * so, and we don't).
 */
import { createHash, randomBytes } from 'node:crypto';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* Handshake: what the server sends back for a client's Sec-WebSocket-Key. */
export function acceptKey(clientKey) {
  return createHash('sha1').update(String(clientKey) + MAGIC).digest('base64');
}

/* One frame, server → client. Servers never mask, so this is short. */
export function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode; // FIN set: we never fragment on the way out
  return Buffer.concat([head, body]);
}

export const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/* Pull as many whole frames as the buffer holds. Returns frames + the tail. */
export function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (true) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;

    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p); p += 8;
      if (big > 8n * 1024n * 1024n) throw new Error('frame too large');
      len = Number(big);
    }

    let mask = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.subarray(p, p + 4); p += 4;
    }
    if (buf.length - p < len) break; // wait for the rest

    const raw = Buffer.from(buf.subarray(p, p + len)); // copy: the mask is applied in place
    p += len;
    if (mask) for (let i = 0; i < raw.length; i++) raw[i] ^= mask[i % 4];

    frames.push({ fin, opcode, payload: raw });
    off = p;
  }
  return { frames, rest: buf.subarray(off) };
}

/* Wrap a socket as a tiny event source: onMessage(text), onClose(reason). */
export function attachSocket(socket, { onMessage, onClose, maxPayload = 1024 * 1024 } = {}) {
  let buf = Buffer.alloc(0);
  let frags = [];
  // Two flags, because closing and notifying are different events: `closed`
  // stops us writing, and is set by us closing; `done` means onClose has run.
  // Sharing one flag meant a graceful close silenced the owner's bookkeeping.
  let closed = false;
  let done = false;

  const conn = {
    socket,
    send(text) { if (!closed && socket.writable) socket.write(encodeFrame(OP.TEXT, text)); },
    sendJson(obj) { conn.send(JSON.stringify(obj)); },
    close(code = 1000, reason = '') {
      if (closed) return;
      closed = true;
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code, 0);
      try { socket.write(encodeFrame(OP.CLOSE, Buffer.concat([body, Buffer.from(reason, 'utf8')]))); } catch {}
      try { socket.end(); } catch {}
    },
    get closed() { return closed; }
  };

  socket.on('data', (chunk) => {
    if (closed) return; // already said goodbye; late frames must not dispatch
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > maxPayload) { conn.close(1009, 'too large'); return; }
    let out;
    try { out = decodeFrames(buf); }
    catch (e) { conn.close(1002, e.message); return; }
    buf = out.rest;

    for (const f of out.frames) {
      if (f.opcode === OP.PING) { try { socket.write(encodeFrame(OP.PONG, f.payload)); } catch {} continue; }
      if (f.opcode === OP.PONG) continue;
      if (f.opcode === OP.CLOSE) { conn.close(1000, 'bye'); return; }

      if (f.opcode === OP.CONT) {
        frags.push(f.payload);
      } else {
        frags = [f.payload];
      }
      if (!f.fin) continue;

      const whole = Buffer.concat(frags);
      frags = [];
      try { (conn.onMessage || onMessage || (() => {}))(whole.toString('utf8'), conn); }
      catch (e) { /* a bad message must not kill the socket */ }
    }
  });

  const bye = (why) => {
    if (done) return;
    done = true;
    closed = true;
    try { (conn.onClose || onClose) && (conn.onClose || onClose)(why); } catch {}
  };
  socket.on('close', () => bye('peer closed'));
  socket.on('error', () => bye('socket error'));
  socket.on('end', () => bye('peer ended'));

  return conn;
}

export function newId(bytes = 6) {
  return randomBytes(bytes).toString('hex');
}
