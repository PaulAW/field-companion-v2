/* exif-writer.js — minimal, dependency-free EXIF writer.
   Inserts an ImageDescription (tag 0x010E) into a JPEG's APP1/Exif segment
   so gallery apps (Google Photos, etc.) can surface it as a caption.
   No third-party library — canvas-generated JPEGs carry no EXIF segment at
   all, so this hand-builds the minimal TIFF/IFD0 structure needed for one
   ASCII field. */

var ExifWriter = (() => {

  function writeDescription(jpegBytes, description) {
    if (jpegBytes[0] !== 0xFF || jpegBytes[1] !== 0xD8) {
      throw new Error('Not a valid JPEG');
    }

    // ImageDescription (type 2 = ASCII) requires 7-bit ASCII.
    let text = String(description || '').replace(/[^\x20-\x7E]/g, '');
    if (!text) text = 'Field Companion';
    if (text.length > 900) text = text.slice(0, 897) + '...';

    const descBytes = new TextEncoder().encode(text + '\0');
    const dataLen = descBytes.length % 2 === 0 ? descBytes.length : descBytes.length + 1; // word-align

    // ── TIFF header + IFD0 (little-endian) ──
    const IFD0_OFFSET = 8;                            // right after the 8-byte TIFF header
    const IFD0_LEN    = 2 + 12 + 4;                   // entry count + 1 entry + next-IFD offset
    const DATA_OFFSET = IFD0_OFFSET + IFD0_LEN;       // where the ASCII string lives

    const tiff = new Uint8Array(8 + IFD0_LEN + dataLen);
    const dv   = new DataView(tiff.buffer);
    tiff[0] = 0x49; tiff[1] = 0x49;                   // "II" little-endian
    dv.setUint16(2, 42, true);
    dv.setUint32(4, IFD0_OFFSET, true);
    dv.setUint16(8, 1, true);                         // 1 directory entry
    dv.setUint16(10, 0x010E, true);                   // tag: ImageDescription
    dv.setUint16(12, 2, true);                        // type: ASCII
    dv.setUint32(14, descBytes.length, true);          // count (incl. null terminator)
    dv.setUint32(18, DATA_OFFSET, true);               // offset to string data
    dv.setUint32(22, 0, true);                         // next IFD offset (none)
    tiff.set(descBytes, DATA_OFFSET);

    // ── Wrap in "Exif\0\0" + APP1 marker ──
    const exifHeader = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
    const payload = new Uint8Array(exifHeader.length + tiff.length);
    payload.set(exifHeader, 0);
    payload.set(tiff, exifHeader.length);

    const segmentLen = payload.length + 2; // length field counts itself
    if (segmentLen > 0xFFFF) throw new Error('Description too long for one EXIF segment');

    const app1 = new Uint8Array(4 + payload.length);
    app1[0] = 0xFF; app1[1] = 0xE1;
    app1[2] = (segmentLen >> 8) & 0xFF;
    app1[3] = segmentLen & 0xFF;
    app1.set(payload, 4);

    // ── Splice: SOI, our new APP1, then everything that followed SOI ──
    const out = new Uint8Array(2 + app1.length + (jpegBytes.length - 2));
    out[0] = 0xFF; out[1] = 0xD8;
    out.set(app1, 2);
    out.set(jpegBytes.subarray(2), 2 + app1.length);
    return out;
  }

  return { writeDescription };
})();
