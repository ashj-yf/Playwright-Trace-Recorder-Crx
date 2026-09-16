/**
 * Streaming ZIP writer for extension service workers.
 *
 * Produces a standard (non-zip64) DEFLATE archive without ever holding the whole
 * archive in the JS heap:
 *  - each entry is compressed through CompressionStream('deflate-raw') chunk by chunk
 *  - the data-descriptor flag (bit 3) lets compressed chunks roll out in order,
 *    before the entry's CRC/sizes are known, so nothing is buffered per entry
 *  - finished bytes are folded into a disk-backed Blob as they accumulate
 *
 * Replaces JSZip on the write path, which buffered every file plus the complete
 * output archive in memory before returning it.
 */

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 0x0800;
// Bit 3: CRC/sizes live in a data descriptor AFTER the payload, so the local
// header can be emitted before compression and compressed chunks stream
// straight into the rolling blob instead of buffering the whole entry.
const FLAG_DATA_DESCRIPTOR = 0x0008;
const DATA_DESCRIPTOR_SIG = 0x08074b50;

const MAX_UINT32 = 0xffffffff;
const MAX_UINT16 = 0xffff;

// ── CRC-32 ────────────────────────────────────────────────────────────────────

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

/**
 * Incremental CRC-32. crc32(b, crc32(a)) equals crc32(concat(a, b)),
 * so an entry's checksum can be accumulated across streamed chunks.
 */
function crc32(bytes, seed = 0) {
  const table = getCrcTable();
  let c = (~seed) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (~c) >>> 0;
}

// ── Rolling blob accumulator ──────────────────────────────────────────────────

/**
 * Collects byte chunks and folds them into a Blob once they exceed `foldBytes`.
 *
 * Blob parts live in the browser's blob store rather than the JS heap, and
 * `new Blob([existingBlob, ...more])` references the previous blob instead of
 * copying it — so total heap stays bounded by foldBytes no matter how large the
 * archive grows.
 */
class RollingBlob {
  constructor(foldBytes = 4 * 1024 * 1024) {
    this._foldBytes = foldBytes;
    this._parts = [];
    this._pending = 0;
    this._blob = null;
    this.length = 0;
  }

  push(bytes) {
    if (!bytes || bytes.byteLength === 0) return;
    this._parts.push(bytes);
    this._pending += bytes.byteLength;
    this.length += bytes.byteLength;
    if (this._pending >= this._foldBytes) this._fold();
  }

  _fold() {
    if (this._parts.length === 0) return;
    const parts = this._blob ? [this._blob].concat(this._parts) : this._parts;
    this._blob = new Blob(parts);
    this._parts = [];
    this._pending = 0;
  }

  toBlob(type) {
    this._fold();
    return this._blob
      ? new Blob([this._blob], { type })
      : new Blob([], { type });
  }
}

// ── Byte helpers ──────────────────────────────────────────────────────────────

const textEncoder = new TextEncoder();

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function toBytes(data) {
  if (typeof data === 'string') return textEncoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('Unsupported zip entry payload');
}

/**
 * Deflate an async-iterable of chunks, invoking `onChunk` for each compressed
 * block as it comes out. Reading runs concurrently with writing so
 * CompressionStream's internal queue never deadlocks on backpressure.
 */
async function deflateRaw(chunks, onChunk) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();

  const drain = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk(value);
    }
  })();

  try {
    for await (const chunk of chunks) {
      const bytes = toBytes(chunk);
      if (bytes.byteLength) await writer.write(bytes);
    }
    await writer.close();
  } catch (err) {
    try { await writer.abort(err); } catch (_) { /* already errored */ }
    throw err;
  }

  await drain;
}

// ── Writer ────────────────────────────────────────────────────────────────────

export class ZipBlobWriter {
  constructor({ mimeType = 'application/zip' } = {}) {
    this._out = new RollingBlob();
    this._entries = [];
    this._names = new Set();
    this._mimeType = mimeType;
    this._finished = false;
    const { time, date } = dosDateTime(new Date());
    this._dosTime = time;
    this._dosDate = date;
  }

  get byteLength() {
    return this._out.length;
  }

  has(name) {
    return this._names.has(name);
  }

  /** Append an entry whose payload is already in memory. */
  addFile(name, data) {
    return this.addStream(name, [data]);
  }

  /**
   * Append an entry, pulling its payload from an (async) iterable of chunks.
   *
   * With the data-descriptor flag the local header is emitted first (zero
   * CRC/sizes), compressed chunks roll into the output blob as they leave
   * CompressionStream, and the real sizes/CRC trail behind as a 16-byte data
   * descriptor. Nothing beyond CompressionStream's own queue is buffered, so a
   * multi-hundred-megabyte incompressible entry never sits in the JS heap.
   */
  async addStream(name, chunks) {
    if (this._finished) throw new Error('ZipBlobWriter already finished');
    if (this._names.has(name)) return false;
    this._names.add(name);

    let crc = 0;
    let rawSize = 0;
    let compSize = 0;

    const nameBytes = textEncoder.encode(name);
    const offset = this._out.length;
    if (offset > MAX_UINT32)
      throw new Error('Zip archive exceeds 4 GB limit');

    // Local file header with placeholder sizes (data descriptor follows).
    const header = new Uint8Array(30 + nameBytes.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, LOCAL_HEADER_SIG, true);
    headerView.setUint16(4, VERSION_NEEDED, true);
    headerView.setUint16(6, FLAG_UTF8 | FLAG_DATA_DESCRIPTOR, true);
    headerView.setUint16(8, METHOD_DEFLATE, true);
    headerView.setUint16(10, this._dosTime, true);
    headerView.setUint16(12, this._dosDate, true);
    headerView.setUint32(14, 0, true); // CRC-32 — in data descriptor
    headerView.setUint32(18, 0, true); // compressed size — in data descriptor
    headerView.setUint32(22, 0, true); // uncompressed size — in data descriptor
    headerView.setUint16(26, nameBytes.length, true);
    headerView.setUint16(28, 0, true); // extra field length
    header.set(nameBytes, 30);
    this._out.push(header);

    // Wrap the source so we can checksum and measure while streaming through.
    const measured = (async function* () {
      for await (const chunk of chunks) {
        const bytes = toBytes(chunk);
        if (!bytes.byteLength) continue;
        crc = crc32(bytes, crc);
        rawSize += bytes.byteLength;
        yield bytes;
      }
    })();

    await deflateRaw(measured, (chunk) => {
      compSize += chunk.byteLength;
      this._out.push(chunk);
    });

    if (rawSize > MAX_UINT32 || compSize > MAX_UINT32)
      throw new Error(`Zip entry "${name}" exceeds the 4 GB limit`);

    // Data descriptor (signature + CRC-32 + compressed + uncompressed size).
    const descriptor = new Uint8Array(16);
    const descriptorView = new DataView(descriptor.buffer);
    descriptorView.setUint32(0, DATA_DESCRIPTOR_SIG, true);
    descriptorView.setUint32(4, crc, true);
    descriptorView.setUint32(8, compSize, true);
    descriptorView.setUint32(12, rawSize, true);
    this._out.push(descriptor);

    this._entries.push({
      nameBytes,
      crc,
      compSize,
      rawSize,
      offset,
      flags: FLAG_UTF8 | FLAG_DATA_DESCRIPTOR
    });
    return true;
  }

  /** Write the central directory and return the archive as a Blob. */
  finish() {
    if (this._finished) throw new Error('ZipBlobWriter already finished');
    this._finished = true;

    if (this._entries.length > MAX_UINT16)
      throw new Error('Zip archive exceeds 65535 entries');

    const centralOffset = this._out.length;
    let centralSize = 0;

    for (const entry of this._entries) {
      const record = new Uint8Array(46 + entry.nameBytes.length);
      const view = new DataView(record.buffer);
      view.setUint32(0, CENTRAL_HEADER_SIG, true);
      view.setUint16(4, VERSION_NEEDED, true);
      view.setUint16(6, VERSION_NEEDED, true);
      view.setUint16(8, entry.flags, true);
      view.setUint16(10, METHOD_DEFLATE, true);
      view.setUint16(12, this._dosTime, true);
      view.setUint16(14, this._dosDate, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.compSize, true);
      view.setUint32(24, entry.rawSize, true);
      view.setUint16(28, entry.nameBytes.length, true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0, true);
      view.setUint32(42, entry.offset, true);
      record.set(entry.nameBytes, 46);

      this._out.push(record);
      centralSize += record.byteLength;
    }

    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, EOCD_SIG, true);
    eocdView.setUint16(4, 0, true);
    eocdView.setUint16(6, 0, true);
    eocdView.setUint16(8, this._entries.length, true);
    eocdView.setUint16(10, this._entries.length, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, centralOffset, true);
    eocdView.setUint16(20, 0, true);
    this._out.push(eocd);

    const blob = this._out.toBlob(this._mimeType);
    this._entries = [];
    this._out = null;
    return blob;
  }
}

export { crc32 };
