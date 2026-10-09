// Minimal .zip archives: files stored as they are (the PNGs inside are compressed
// already), for exporting the review crops; and a reader for the import tool.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS time and date of a file in the archive (local time, 2 s resolution)
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

/** files: [{name, data: Uint8Array | string, date?: Date}] -> the bytes of a .zip */
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], dir = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const [time, date] = dosTime(f.date || new Date());
    const head = new Uint8Array(30 + name.length);
    const h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);       // version needed
    h.setUint16(6, 0x0800, true);   // names in UTF-8
    h.setUint16(8, 0, true);        // stored
    h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    head.set(name, 30);
    const ent = new Uint8Array(46 + name.length);
    const e = new DataView(ent.buffer);
    e.setUint32(0, 0x02014b50, true);
    e.setUint16(4, 20, true); e.setUint16(6, 20, true); e.setUint16(8, 0x0800, true); e.setUint16(10, 0, true);
    e.setUint16(12, time, true); e.setUint16(14, date, true);
    e.setUint32(16, crc, true); e.setUint32(20, data.length, true); e.setUint32(24, data.length, true);
    e.setUint16(28, name.length, true);
    e.setUint32(42, offset, true);
    ent.set(name, 46);
    parts.push(head, data);
    dir.push(ent);
    offset += head.length + data.length;
  }
  const dirSize = dir.reduce((a, d) => a + d.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, files.length, true); v.setUint16(10, files.length, true);
  v.setUint32(12, dirSize, true); v.setUint32(16, offset, true);
  const out = new Uint8Array(offset + dirSize + end.length);
  let p = 0;
  for (const a of [...parts, ...dir, end]) { out.set(a, p); p += a.length; }
  return out;
}

/**
 * The files of a .zip: [{name, data}]. Compressed files need inflateRaw(bytes) (in
 * Node: zlib.inflateRawSync), e.g. for an archive that was unpacked and packed again.
 */
export function readZip(buf, inflateRaw = null) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = buf.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a .zip file');
  const n = v.getUint16(end + 10, true);
  const dec = new TextDecoder();
  const out = [];
  let p = v.getUint32(end + 16, true);
  for (let i = 0; i < n; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('damaged .zip directory');
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), noteLen = v.getUint16(p + 32, true);
    const at = v.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    const start = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true);
    const raw = buf.subarray(start, start + size);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8 && inflateRaw) out.push({ name, data: new Uint8Array(inflateRaw(raw)) });
    else throw new Error(`${name}: compression not supported`);
    p += 46 + nameLen + extraLen + noteLen;
  }
  return out;
}
