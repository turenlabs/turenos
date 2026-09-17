//! Unit tests build every fixture in code: PNG chunks with real CRCs,
//! JPEG marker segments, a hand-laid-out little-endian TIFF with a GPS IFD
//! and a thumbnail IFD, GIF89a blocks, a WebP RIFF/VP8X container, BMP, ICO,
//! and an AVIF-flavored BMFF box tree.

use crate::{image_exif, image_inspect, image_pixel_stats, image_text_chunks};

fn json(text: String) -> serde_json::Value {
    serde_json::from_str(&text).expect("valid json")
}

fn error_code(text: String) -> String {
    json(text)["error"].as_str().unwrap_or_default().to_string()
}

// ------------------------------------------------------------ fixtures ----

fn png_chunk(name: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(name);
    out.extend_from_slice(payload);
    let crc = crc32fast::hash(
        &out[out.len() - 4 - payload.len()..],
    );
    out.extend_from_slice(&crc.to_be_bytes());
    out
}

fn ihdr(width: u32, height: u32, bit_depth: u8, color: u8) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&width.to_be_bytes());
    payload.extend_from_slice(&height.to_be_bytes());
    payload.extend_from_slice(&[bit_depth, color, 0, 0, 0]);
    png_chunk(b"IHDR", &payload)
}

fn zlib(payload: &[u8]) -> Vec<u8> {
    use std::io::Read;
    let mut encoder =
        flate2::bufread::ZlibEncoder::new(payload, flate2::Compression::fast());
    let mut out = Vec::new();
    encoder.read_to_end(&mut out).unwrap();
    out
}

/// 4x4 RGB PNG with a tEXt chunk; `idat` is real zlib data so
/// `image_pixel_stats` can decode it.
fn minimal_png() -> Vec<u8> {
    let mut raw = Vec::new();
    for y in 0..4u8 {
        raw.push(0); // filter none
        for x in 0..4u8 {
            raw.extend_from_slice(&[x * 60, y * 60, (x + y) * 30]);
        }
    }
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend(ihdr(4, 4, 8, 2));
    png.extend(png_chunk(b"tEXt", b"Author\x00fixture builder"));
    png.extend(png_chunk(b"IDAT", &zlib(&raw)));
    png.extend(png_chunk(b"IEND", &[]));
    png
}

/// Little-endian TIFF: IFD0 with Make/Model/Software/DateTime/Orientation and
/// a GPSInfo pointer into a GPS IFD with N 37°48'30" / W 122°24'15" / 15m.
/// `thumbnail` adds an IFD1 with JPEGInterchangeFormat/Length pointing at a
/// fake thumbnail payload appended at the end.
fn tiff_block(thumbnail: bool) -> Vec<u8> {
    fn entry(tag: u16, typ: u16, count: u32, value: u32) -> [u8; 12] {
        let mut out = [0u8; 12];
        out[0..2].copy_from_slice(&tag.to_le_bytes());
        out[2..4].copy_from_slice(&typ.to_le_bytes());
        out[4..8].copy_from_slice(&count.to_le_bytes());
        out[8..12].copy_from_slice(&value.to_le_bytes());
        out
    }
    let strings: &[&[u8]] = &[
        b"Canon\0",
        b"EOS T80\0",
        b"verify-soft 1.0\0",
        b"2024:01:02 03:04:05\0",
    ];
    let ifd0_count = if thumbnail { 7 } else { 6 };
    let ifd0_len = 2 + ifd0_count * 12 + 4;
    let strings_off = 8 + ifd0_len;
    let mut offs = Vec::new();
    let mut cursor = strings_off;
    for s in strings {
        offs.push(cursor);
        cursor += s.len();
    }
    let gps_off = cursor;
    let gps_count = 6;
    let gps_len = 2 + gps_count * 12 + 4;
    let rat_off = gps_off + gps_len;
    // "\xff\xd8" + "FAKETHUMBNAIL" + "\xff\xd9" = 17 bytes
    let thumb_data_len = if thumbnail { 17usize } else { 0 };
    let ifd1_off = rat_off + 7 * 8;
    let thumb_off = ifd1_off + 2 + 2 * 12 + 4;

    let mut data = Vec::new();
    data.extend_from_slice(b"II");
    data.extend_from_slice(&42u16.to_le_bytes());
    data.extend_from_slice(&8u32.to_le_bytes());
    // IFD0
    data.extend_from_slice(&(ifd0_count as u16).to_le_bytes());
    data.extend_from_slice(&entry(0x010f, 2, 6, offs[0] as u32));
    data.extend_from_slice(&entry(0x0110, 2, 8, offs[1] as u32));
    data.extend_from_slice(&entry(0x0131, 2, 16, offs[2] as u32));
    data.extend_from_slice(&entry(0x0132, 2, 20, offs[3] as u32));
    data.extend_from_slice(&entry(0x0112, 3, 1, 1));
    data.extend_from_slice(&entry(0x8825, 4, 1, gps_off as u32));
    if thumbnail {
        data.extend_from_slice(&entry(0x0111, 4, 1, 0)); // StripOffsets
        data.extend_from_slice(&(ifd1_off as u32).to_le_bytes()); // next -> IFD1
    } else {
        data.extend_from_slice(&0u32.to_le_bytes());
    }
    for s in strings {
        data.extend_from_slice(s);
    }
    assert_eq!(data.len(), gps_off);
    // GPS IFD
    data.extend_from_slice(&(gps_count as u16).to_le_bytes());
    let mut e = entry(1, 2, 2, 0);
    e[8] = b'N';
    data.extend_from_slice(&e);
    data.extend_from_slice(&entry(2, 5, 3, rat_off as u32));
    let mut e = entry(3, 2, 2, 0);
    e[8] = b'W';
    data.extend_from_slice(&e);
    data.extend_from_slice(&entry(4, 5, 3, (rat_off + 24) as u32));
    data.extend_from_slice(&entry(5, 1, 1, 0));
    data.extend_from_slice(&entry(6, 5, 1, (rat_off + 48) as u32));
    data.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(data.len(), rat_off);
    for (num, den) in [(37u32, 1u32), (48, 1), (30, 1)] {
        data.extend_from_slice(&num.to_le_bytes());
        data.extend_from_slice(&den.to_le_bytes());
    }
    for (num, den) in [(122u32, 1u32), (24, 1), (15, 1)] {
        data.extend_from_slice(&num.to_le_bytes());
        data.extend_from_slice(&den.to_le_bytes());
    }
    data.extend_from_slice(&15u32.to_le_bytes());
    data.extend_from_slice(&1u32.to_le_bytes());
    if thumbnail {
        assert_eq!(data.len(), ifd1_off);
        data.extend_from_slice(&2u16.to_le_bytes());
        data.extend_from_slice(&entry(0x0201, 4, 1, thumb_off as u32));
        data.extend_from_slice(&entry(0x0202, 4, 1, thumb_data_len as u32));
        data.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(data.len(), thumb_off);
        data.extend_from_slice(b"\xff\xd8FAKETHUMBNAIL\xff\xd9");
    }
    data
}

fn jpeg_segment(marker: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0xff, marker];
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Structure-only JPEG: SOI, APP0/JFIF, APP1/Exif, COM, DQT, SOF0, SOS+scan,
/// EOI. Not decodable — pixel tests use `TINY_JPEG`.
fn struct_jpeg() -> Vec<u8> {
    let mut jpg = b"\xff\xd8".to_vec();
    jpg.extend(jpeg_segment(0xe0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"));
    jpg.extend(jpeg_segment(0xe1, &[b"Exif\x00\x00".as_ref(), &tiff_block(false)].concat()));
    jpg.extend(jpeg_segment(0xfe, b"a comment here"));
    jpg.extend(jpeg_segment(0xdb, &[0u8; 64]));
    let mut sof = vec![8u8, 0, 4, 0, 4, 3];
    sof.extend_from_slice(&[1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    jpg.extend(jpeg_segment(0xc0, &sof));
    jpg.extend(jpeg_segment(0xda, &[3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]));
    jpg.extend_from_slice(&[0x11, 0x22, 0x33, 0xff, 0x00, 0xaa]); // fake scan
    jpg.extend_from_slice(&[0xff, 0xd9]);
    jpg
}

fn gif89a() -> Vec<u8> {
    let mut gif = b"GIF89a".to_vec();
    gif.extend_from_slice(&4u16.to_le_bytes()); // width
    gif.extend_from_slice(&4u16.to_le_bytes()); // height
    gif.push(0x80 | 0x10 | 0x01); // gct flag, color res 2, gct size 4 entries? -> 2^(1+1)=4
    gif.push(0); // bg
    gif.push(0); // aspect
    gif.extend_from_slice(&[0u8; 12]); // GCT: 4 entries * 3 bytes
    // comment extension: 21 FE, sub-block "hello", terminator
    gif.extend_from_slice(&[0x21, 0xfe, 5]);
    gif.extend_from_slice(b"hello");
    gif.push(0);
    // graphic control extension
    gif.extend_from_slice(&[0x21, 0xf9, 4, 0, 5, 0, 0, 0]);
    // image descriptor: left,top 0; w,h 4; packed 0
    gif.push(0x2c);
    gif.extend_from_slice(&[0, 0, 0, 0, 4, 0, 4, 0, 0]);
    gif.push(2); // lzw min code size
    gif.extend_from_slice(&[3, 0x44, 0x05, 0x00]); // one sub-block
    gif.push(0); // block terminator
    gif.push(0x3b); // trailer
    gif
}

fn webp_vp8x() -> Vec<u8> {
    fn chunk(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = fourcc.to_vec();
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(payload);
        if payload.len() % 2 == 1 {
            out.push(0);
        }
        out
    }
    let mut vp8x = vec![0x0cu8]; // exif|xmp flags set
    vp8x.extend_from_slice(&[0, 0, 0]);
    vp8x.extend_from_slice(&[3, 0, 0]); // width-1 = 3 -> 4
    vp8x.extend_from_slice(&[3, 0, 0]); // height-1 = 3 -> 4
    let exif = tiff_block(false);
    let body = [
        chunk(b"VP8X", &vp8x),
        chunk(b"EXIF", &exif),
    ]
    .concat();
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&((4 + body.len()) as u32).to_le_bytes());
    out.extend_from_slice(b"WEBP");
    out.extend_from_slice(&body);
    out
}

fn bmp() -> Vec<u8> {
    let mut bmp = b"BM".to_vec();
    let pixel_off = 14 + 40;
    let size = pixel_off + 4 * 4 * 3; // 4x4 rgb24
    bmp.extend_from_slice(&(size as u32).to_le_bytes());
    bmp.extend_from_slice(&[0, 0, 0, 0]);
    bmp.extend_from_slice(&(pixel_off as u32).to_le_bytes());
    bmp.extend_from_slice(&40u32.to_le_bytes()); // BITMAPINFOHEADER
    bmp.extend_from_slice(&4i32.to_le_bytes());
    bmp.extend_from_slice(&4i32.to_le_bytes());
    bmp.extend_from_slice(&1u16.to_le_bytes());
    bmp.extend_from_slice(&24u16.to_le_bytes());
    bmp.extend_from_slice(&0u32.to_le_bytes());
    bmp.extend_from_slice(&[0u8; 20]);
    bmp.extend_from_slice(&[128u8; 48]); // pixel payload
    bmp
}

fn ico() -> Vec<u8> {
    let inner = minimal_png();
    let mut ico = vec![0, 0, 1, 0];
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&[4, 4, 0, 0]);
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&32u16.to_le_bytes());
    ico.extend_from_slice(&(inner.len() as u32).to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    ico.extend_from_slice(&inner);
    ico
}

fn avif() -> Vec<u8> {
    fn bx(name: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(name);
        out.extend_from_slice(payload);
        out
    }
    fn full(name: &[u8; 4], version: u8, payload: &[u8]) -> Vec<u8> {
        let mut p = vec![version, 0, 0, 0];
        p.extend_from_slice(payload);
        bx(name, &p)
    }
    // ftyp: major avif, minor 0, compat avif+mif1
    let ftyp = bx(b"ftyp", b"avif\x00\x00\x00\x00avifmif1");
    // ispe property (full box): w=64, h=32
    let mut ispe = 4u32.to_be_bytes().to_vec();
    ispe.extend_from_slice(&64u32.to_be_bytes());
    ispe.extend_from_slice(&32u32.to_be_bytes());
    let ipco = bx(b"ipco", &full(b"ispe", 0, &ispe[4..]).to_vec());
    let iprp = bx(b"iprp", &ipco);
    let meta = full(b"meta", 0, &iprp);
    [ftyp, meta].concat()
}

fn text(png: &[u8]) -> serde_json::Value {
    json(image_text_chunks(png, "{}"))
}

// ---------------------------------------------------------------- tests ----

#[test]
fn png_structure() {
    let report = json(image_inspect(&minimal_png(), "{}"));
    assert_eq!(report["format"], "png");
    assert_eq!(report["width"], 4);
    assert_eq!(report["height"], 4);
    assert_eq!(report["bit_depth"], 8);
    assert_eq!(report["color_type"], "rgb");
    let chunks = report["chunks"].as_array().unwrap();
    let names: Vec<&str> = chunks.iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["IHDR", "tEXt", "IDAT", "IEND"]);
    assert!(chunks.iter().all(|c| c["crc_valid"] == true));
    assert_eq!(chunks[0]["offset"], 8);
    assert_eq!(report["exif_present"], false);
    assert!(report["trailing_bytes"].is_null());
    assert_eq!(report["anomalies"].as_array().unwrap().len(), 0);
    assert_eq!(report["truncated"], false);
    // text chunk decoded
    let texts = report["text_chunks"].as_array().unwrap();
    assert_eq!(texts[0]["keyword"], "Author");
    assert_eq!(texts[0]["text"], "fixture builder");
    assert_eq!(texts[0]["encoding"], "latin-1");
    assert_eq!(texts[0]["location"], "png:tEXt");
}

#[test]
fn png_trailing_and_post_iend() {
    let mut png = minimal_png();
    png.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
    let report = json(image_inspect(&png, "{}"));
    let trailing = &report["trailing_bytes"];
    assert_eq!(trailing["length"], 4);
    assert_eq!(trailing["hex_preview"], "deadbeef");
    assert!(report["anomalies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a == "trailing_bytes_after_iend"));

    // a whole chunk after IEND is flagged separately
    let mut png2 = minimal_png();
    png2.extend(png_chunk(b"ruSH", b"payload"));
    let report2 = json(image_inspect(&png2, "{}"));
    assert!(report2["anomalies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a.as_str().unwrap_or("").starts_with("chunks_after_iend")));
}

#[test]
fn png_bad_crc_flagged() {
    let mut png = minimal_png();
    // corrupt the tEXt CRC (last 4 bytes of that chunk)
    let text_crc_off = {
        let mut off = 8;
        loop {
            let len = u32::from_be_bytes([png[off], png[off + 1], png[off + 2], png[off + 3]]) as usize;
            if &png[off + 4..off + 8] == b"tEXt" {
                break;
            }
            off += 8 + len + 4;
        }
        let len = u32::from_be_bytes([png[off], png[off + 1], png[off + 2], png[off + 3]]) as usize;
        off + 8 + len
    };
    png[text_crc_off] ^= 0xff;
    let report = json(image_inspect(&png, "{}"));
    let text_chunk = report["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "tEXt")
        .unwrap();
    assert_eq!(text_chunk["crc_valid"], false);
    assert!(report["anomalies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a == "crc_mismatch:tEXt"));
}

#[test]
fn png_ztxt_and_itxt() {
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend(ihdr(1, 1, 8, 0));
    // zTXt: keyword\0 method(0) zlib(text)
    let mut ztxt = b"Comment\x00\x00".to_vec();
    ztxt.extend(zlib(b"compressed latin1 text"));
    png.extend(png_chunk(b"zTXt", &ztxt));
    // iTXt: keyword\0 flag0 method0 lang\0 translated\0 utf8
    let itxt = b"Note\x00\x00\x00en\x00Translated\x00utf8 note text".to_vec();
    png.extend(png_chunk(b"iTXt", &itxt));
    png.extend(png_chunk(b"IDAT", &zlib(&[0, 0])));
    png.extend(png_chunk(b"IEND", &[]));
    let report = text(&png);
    let entries = report["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["text"], "compressed latin1 text");
    assert_eq!(entries[0]["keyword"], "Comment");
    assert_eq!(entries[1]["text"], "utf8 note text");
    assert_eq!(entries[1]["encoding"], "utf-8");
}

#[test]
fn png_non_utf8_itxt_hex_fallback() {
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend(ihdr(1, 1, 8, 0));
    let itxt = b"Bin\x00\x00\x00\x00\x00\xff\xfe\x00\x01binary".to_vec();
    png.extend(png_chunk(b"iTXt", &itxt));
    png.extend(png_chunk(b"IEND", &[]));
    let report = text(&png);
    let entries = report["entries"].as_array().unwrap();
    assert_eq!(entries[0]["encoding"], "hex");
    assert!(entries[0]["text"].as_str().unwrap().starts_with("fffe"));
}

#[test]
fn png_exif_chunk_located() {
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend(ihdr(2, 2, 8, 6));
    png.extend(png_chunk(b"eXIf", &tiff_block(false)));
    png.extend(png_chunk(b"IDAT", &zlib(&[0; 20])));
    png.extend(png_chunk(b"IEND", &[]));
    let inspect = json(image_inspect(&png, "{}"));
    assert_eq!(inspect["exif_present"], true);
    let exif = json(image_exif(&png, "{}"));
    assert_eq!(exif["exif_present"], true);
    assert_eq!(exif["make"], "Canon");
}

#[test]
fn png_malformed() {
    // truncated mid-chunk
    let mut png = minimal_png();
    png.truncate(png.len() - 10);
    let report = json(image_inspect(&png, "{}"));
    assert!(report["anomalies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a.as_str().unwrap_or("").contains("truncated")
            || a.as_str().unwrap_or("").contains("missing_iend")));

    // declared length beyond EOF
    let mut png2 = b"\x89PNG\r\n\x1a\n".to_vec();
    png2.extend(ihdr(1, 1, 8, 0));
    let mut huge = Vec::new();
    huge.extend_from_slice(&0x00ff_ffffu32.to_be_bytes());
    huge.extend_from_slice(b"IDAT");
    huge.extend_from_slice(&[0u8; 8]);
    png2.extend(huge);
    let report2 = json(image_inspect(&png2, "{}"));
    assert!(report2["anomalies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a.as_str().unwrap_or("").starts_with("chunk_length_past_eof")));

    // unknown critical chunk
    let mut png3 = b"\x89PNG\r\n\x1a\n".to_vec();
    png3.extend(ihdr(1, 1, 8, 0));
    png3.extend(png_chunk(b"ABCD", b"x"));
    png3.extend(png_chunk(b"IEND", &[]));
    let report3 = json(image_inspect(&png3, "{}"));
    assert!(report3["anomalies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a == "unknown_critical_chunk:ABCD"));
}

#[test]
fn jpeg_structure() {
    let report = json(image_inspect(&struct_jpeg(), "{}"));
    assert_eq!(report["format"], "jpeg");
    assert_eq!(report["width"], 4);
    assert_eq!(report["height"], 4);
    assert_eq!(report["bit_depth"], 8);
    assert_eq!(report["color_type"], "ycbcr");
    let names: Vec<&str> = report["segments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    for expected in ["SOI", "APP0", "APP1", "COM", "DQT", "SOF0", "SOS", "scan_data", "EOI"] {
        assert!(names.contains(&expected), "missing {expected} in {names:?}");
    }
    assert_eq!(report["exif_present"], true);
    assert_eq!(report["jfif_version"], "1.1");
    let texts = report["text_chunks"].as_array().unwrap();
    assert!(texts.iter().any(|t| t["text"] == "a comment here"));
}

#[test]
fn jpeg_trailing_and_missing_eoi() {
    let mut jpg = struct_jpeg();
    jpg.extend_from_slice(&[1, 2, 3]);
    let report = json(image_inspect(&jpg, "{}"));
    assert_eq!(report["trailing_bytes"]["length"], 3);

    let mut jpg2 = struct_jpeg();
    jpg2.truncate(jpg2.len() - 2); // drop EOI
    let report2 = json(image_inspect(&jpg2, "{}"));
    assert!(report2["anomalies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a == "missing_eoi"));
}

#[test]
fn jpeg_exif_fields_and_gps() {
    let report = json(image_exif(&struct_jpeg(), "{}"));
    assert_eq!(report["exif_present"], true);
    assert_eq!(report["format"], "jpeg");
    assert_eq!(report["make"], "Canon");
    assert_eq!(report["model"], "EOS T80");
    assert_eq!(report["software"], "verify-soft 1.0");
    assert_eq!(report["datetime"], "2024:01:02 03:04:05");
    let gps = &report["gps"];
    let lat = gps["latitude"].as_f64().unwrap();
    let lon = gps["longitude"].as_f64().unwrap();
    assert!((lat - (37.0 + 48.0 / 60.0 + 30.0 / 3600.0)).abs() < 1e-6);
    assert!((lon - (-(122.0 + 24.0 / 60.0 + 15.0 / 3600.0))).abs() < 1e-6);
    assert_eq!(gps["altitude_meters"], 15.0);
    assert!(report["fields_total"].as_u64().unwrap() >= 10);
}

#[test]
fn gif_structure() {
    let report = json(image_inspect(&gif89a(), "{}"));
    assert_eq!(report["format"], "gif");
    assert_eq!(report["width"], 4);
    assert_eq!(report["height"], 4);
    assert_eq!(report["frames"], 1);
    assert_eq!(report["gif_version"], "89a");
    let texts = report["text_chunks"].as_array().unwrap();
    assert!(texts.iter().any(|t| t["text"] == "hello" && t["location"] == "gif:comment"));

    let mut gif2 = gif89a();
    gif2.extend_from_slice(&[9, 9, 9]);
    let report2 = json(image_inspect(&gif2, "{}"));
    assert_eq!(report2["trailing_bytes"]["length"], 3);
    assert_eq!(report2["trailing_bytes"]["hex_preview"], "090909");
}

#[test]
fn webp_structure() {
    let report = json(image_inspect(&webp_vp8x(), "{}"));
    assert_eq!(report["format"], "webp");
    assert_eq!(report["width"], 4);
    assert_eq!(report["height"], 4);
    assert_eq!(report["variant"], "extended");
    assert_eq!(report["exif_present"], true);
    let names: Vec<&str> = report["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["VP8X", "EXIF"]);
    let exif = json(image_exif(&webp_vp8x(), "{}"));
    assert_eq!(exif["make"], "Canon");
}

#[test]
fn bmp_structure() {
    let report = json(image_inspect(&bmp(), "{}"));
    assert_eq!(report["format"], "bmp");
    assert_eq!(report["width"], 4);
    assert_eq!(report["height"], 4);
    assert_eq!(report["bit_depth"], 24);
    assert_eq!(report["color_type"], "rgb");
    assert_eq!(report["compression"], "rgb");
    assert!(report["trailing_bytes"].is_null());
}

#[test]
fn tiff_structure_and_exif() {
    let report = json(image_inspect(&tiff_block(false), "{}"));
    assert_eq!(report["format"], "tiff");
    assert_eq!(report["endian"], "little");
    assert_eq!(report["exif_present"], true);
    let exif = json(image_exif(&tiff_block(false), "{}"));
    assert_eq!(exif["format"], "tiff");
    assert_eq!(exif["make"], "Canon");
    assert!((exif["gps"]["latitude"].as_f64().unwrap() - 37.808333).abs() < 1e-4);
}

#[test]
fn tiff_thumbnail_report() {
    let tiff = tiff_block(true);
    let exif = json(image_exif(&tiff, "{}"));
    let thumb = &exif["thumbnail"];
    assert_eq!(thumb["present"], true);
    assert_eq!(thumb["length"], 17);
    assert_eq!(thumb["sha256"].as_str().unwrap().len(), 64);
    assert!(thumb["data_base64"].as_str().is_some());
}

#[test]
fn ico_structure() {
    let report = json(image_inspect(&ico(), "{}"));
    assert_eq!(report["format"], "ico");
    assert_eq!(report["directory_entries"], 1);
    assert_eq!(report["kind"], "icon");
    assert_eq!(report["width"], 4);
    assert_eq!(report["height"], 4);
    assert_eq!(report["bit_depth"], 32);
    let entry = &report["entries"][0];
    assert!(entry["detail"].as_str().unwrap().contains("png"));
}

#[test]
fn avif_structure() {
    let report = json(image_inspect(&avif(), "{}"));
    assert_eq!(report["format"], "avif");
    assert_eq!(report["width"], 64);
    assert_eq!(report["height"], 32);
    assert_eq!(report["major_brand"], "avif");
    let names: Vec<&str> = report["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"ftyp"));
    assert!(names.contains(&"meta"));
    assert!(names.contains(&"ipco/ispe"));
}

#[test]
fn text_chunks_op() {
    let report = text(&minimal_png());
    assert_eq!(report["schema_version"], 1);
    assert_eq!(report["format"], "png");
    let entries = report["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["keyword"], "Author");
    assert_eq!(report["entries_total"], 1);

    let jpg = struct_jpeg();
    let jreport = json(image_text_chunks(&jpg, "{}"));
    assert!(jreport["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["text"] == "a comment here" && e["location"] == "jpeg:COM"));
}

#[test]
fn exif_absent_and_invalid() {
    let png = minimal_png();
    let report = json(image_exif(&png, "{}"));
    assert_eq!(report["exif_present"], false);

    let mut bad = b"\x89PNG\r\n\x1a\n".to_vec();
    bad.extend(ihdr(1, 1, 8, 0));
    bad.extend(png_chunk(b"eXIf", b"not a tiff at all"));
    bad.extend(png_chunk(b"IEND", &[]));
    assert_eq!(error_code(image_exif(&bad, "{}")), "invalid_exif");
}

#[test]
fn malformed_and_bounded_inputs() {
    assert_eq!(error_code(image_inspect(b"", "{}")), "empty_input");
    assert_eq!(error_code(image_inspect(b"not an image", "{}")), "unknown_format");
    assert_eq!(error_code(image_text_chunks(b"\x00\x01\x02", "{}")), "unknown_format");
    assert_eq!(error_code(image_exif(b"\x00\x01\x02", "{}")), "unknown_format");

    let big = vec![0u8; 32 * 1024 * 1024 + 1];
    assert_eq!(error_code(image_inspect(&big, "{}")), "input_too_large");
    assert_eq!(error_code(image_pixel_stats(&big, "{}")), "input_too_large");

    let options = format!("{{\"pad\":\"{}\"}}", "x".repeat(5000));
    assert_eq!(error_code(image_inspect(&minimal_png(), &options)), "options_too_large");
    for bad in ["not json", "[1]", "42", "\"str\""] {
        assert_eq!(error_code(image_inspect(&minimal_png(), bad)), "invalid_options");
    }
}

#[test]
fn pixel_stats_png() {
    let report = json(image_pixel_stats(&minimal_png(), "{}"));
    assert_eq!(report["format"], "png");
    assert_eq!(report["width"], 4);
    assert_eq!(report["height"], 4);
    assert_eq!(report["decoded"], true);
    let hist: Vec<u64> = report["luma_histogram"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap())
        .collect();
    assert_eq!(hist.iter().sum::<u64>(), 16);
    assert_eq!(report["total_pixels"], 16);
    let means = &report["channel_means"];
    // x in 0..4 -> r mean = 90; y -> g mean = 90; b=(x+y)*30 mean = 90
    assert!((means["red"].as_f64().unwrap() - 90.0).abs() < 0.01);
    assert!((means["green"].as_f64().unwrap() - 90.0).abs() < 0.01);
    assert_eq!(means["alpha"], 255.0);
}

#[test]
fn pixel_stats_jpeg() {
    let report = json(image_pixel_stats(TINY_JPEG, "{}"));
    assert_eq!(report["format"], "jpeg");
    assert_eq!(report["width"], 4);
    assert_eq!(report["height"], 4);
    assert_eq!(report["decoded"], true);
}

#[test]
fn pixel_stats_bounds() {
    // header claims 5000x5000 -> refused before decode
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend(ihdr(5000, 5000, 8, 2));
    png.extend(png_chunk(b"IEND", &[]));
    let report = json(image_pixel_stats(&png, "{}"));
    assert_eq!(report["error"], "image_too_large");
    assert_eq!(report["width"], 5000);

    // smaller cap option
    let report2 = json(image_pixel_stats(&minimal_png(), "{\"max_dimension\":2}"));
    assert_eq!(report2["error"], "image_too_large");

    // unsupported format
    assert_eq!(error_code(image_pixel_stats(&gif89a(), "{}")), "unsupported_format");
}

#[test]
fn determinism() {
    let png = minimal_png();
    assert_eq!(image_inspect(&png, "{}"), image_inspect(&png, "{}"));
    let jpg = struct_jpeg();
    assert_eq!(image_inspect(&jpg, "{}"), image_inspect(&jpg, "{}"));
    assert_eq!(image_exif(&jpg, "{}"), image_exif(&jpg, "{}"));
    assert_eq!(image_text_chunks(&jpg, "{}"), image_text_chunks(&jpg, "{}"));
    assert_eq!(
        image_pixel_stats(&png, "{}"),
        image_pixel_stats(&png, "{}")
    );
}

#[test]
fn tiny_jpeg_inspect() {
    let report = json(image_inspect(TINY_JPEG, "{}"));
    assert_eq!(report["format"], "jpeg");
    assert_eq!(report["width"], 4);
    assert_eq!(report["height"], 4);
    let names: Vec<&str> = report["segments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"SOF0"));
    assert!(names.contains(&"scan_data"));
    assert!(names.contains(&"EOI"));
}

/// A real decodable 4x4 baseline JPEG produced by ffmpeg — used for the
/// `image_pixel_stats` decode path, which a hand-built segment stream cannot
/// exercise. Contains a COM segment ("Lavc62.28.101").
const TINY_JPEG: &[u8] = &[
    255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 2, 0, 0, 1, 0, 1, 0, 0,
    255, 254, 0, 16, 76, 97, 118, 99, 54, 50, 46, 50, 56, 46, 49, 48, 49, 0, 255, 219,
    0, 67, 0, 8, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6,
    6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 8, 8, 8, 7, 7, 7, 6, 6, 7,
    7, 8, 8, 8, 8, 9, 9, 9, 8, 8, 8, 8, 9, 9, 10, 10, 10, 12, 12, 11,
    11, 14, 14, 14, 17, 17, 20, 255, 196, 0, 104, 0, 1, 1, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 2, 6, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 4, 6, 16, 0, 1, 5, 0, 3, 0, 3, 1, 0, 0,
    0, 0, 0, 0, 0, 0, 3, 1, 6, 4, 5, 2, 0, 17, 18, 118, 177, 19, 51, 17,
    0, 1, 4, 1, 4, 1, 5, 1, 0, 0, 0, 0, 0, 0, 0, 0, 3, 4, 2, 5,
    1, 6, 0, 17, 7, 19, 18, 118, 180, 55, 117, 181, 54, 255, 192, 0, 17, 8, 0, 4,
    0, 4, 3, 1, 18, 0, 2, 18, 0, 3, 18, 0, 255, 218, 0, 12, 3, 1, 0, 2,
    17, 3, 17, 0, 63, 0, 158, 112, 146, 221, 181, 29, 187, 10, 150, 253, 193, 85, 25, 91,
    181, 37, 88, 240, 108, 77, 12, 10, 85, 18, 143, 101, 81, 70, 252, 240, 164, 47, 132, 209,
    119, 215, 173, 107, 181, 94, 39, 239, 244, 110, 124, 106, 167, 232, 188, 172, 226, 120, 28, 63,
    47, 195, 133, 41, 53, 135, 98, 18, 11, 109, 108, 138, 119, 168, 83, 8, 137, 73, 136, 196,
    202, 136, 22, 91, 202, 164, 101, 35, 157, 109, 110, 238, 187, 118, 222, 87, 119, 85, 90, 71,
    0, 252, 116, 31, 181, 154, 253, 3, 105, 113, 177, 109, 91, 43, 149, 33, 34, 181, 181, 80,
    185, 36, 156, 56, 78, 195, 108, 165, 90, 112, 245, 24, 15, 90, 75, 101, 246, 149, 56, 142,
    212, 64, 115, 90, 198, 141, 18, 100, 225, 107, 118, 30, 149, 3, 253, 63, 36, 122, 230, 95,
    219, 33, 215, 255, 217,
];
