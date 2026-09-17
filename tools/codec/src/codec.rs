//! Compression transforms. Every algorithm is implemented by a pure-Rust
//! crates.io dependency and every output path is bounded before allocation.

use std::io::{Cursor, Write};

use serde_json::json;

use crate::bounded::{codec_error, finish_bounded, read_bounded, read_into, BoundedWriter};
use crate::{err_with, Options, MAX_LZMA_DICT_BYTES, MAX_ZSTD_WINDOW_BYTES};

const BROTLI_BUFFER: usize = 64 * 1024;
const BROTLI_WINDOW: u32 = 22;
/// Ceiling for caller-provided `expectedOutputBytes` pre-reservation hints.
const HINT_CAP: usize = 4 * 1024 * 1024;

pub(crate) fn decompress(
    algorithm: &str,
    bytes: &[u8],
    options: &Options,
) -> Result<Vec<u8>, String> {
    match normalize(algorithm).as_str() {
        "gzip" => read_bounded(
            flate2::read::MultiGzDecoder::new(bytes),
            options,
            "decompress_failed",
        ),
        "zlib" => read_bounded(
            flate2::read::ZlibDecoder::new(bytes),
            options,
            "decompress_failed",
        ),
        "deflate" => read_bounded(
            flate2::read::DeflateDecoder::new(bytes),
            options,
            "decompress_failed",
        ),
        "brotli" => read_bounded(
            brotli::Decompressor::new(bytes, BROTLI_BUFFER),
            options,
            "decompress_failed",
        ),
        "lz4" => decompress_lz4_frame(bytes, options),
        "lz4-block" => decompress_lz4_block(bytes, options),
        "bzip2" => read_bounded(
            bzip2_rs::DecoderReader::new(bytes),
            options,
            "decompress_failed",
        ),
        "zstd" => decompress_zstd(bytes, options),
        "xz" => decompress_xz(bytes, options),
        "lzma" => decompress_lzma(bytes, options),
        "lzma2" => decompress_lzma2(bytes, options),
        _ => Err(err_with(
            "unknown_algorithm",
            json!({ "algorithm": algorithm }),
        )),
    }
}

pub(crate) fn compress(
    algorithm: &str,
    bytes: &[u8],
    options: &Options,
) -> Result<Vec<u8>, String> {
    match normalize(algorithm).as_str() {
        "gzip" | "zlib" | "deflate" => compress_deflate_family(algorithm, bytes, options),
        "brotli" => compress_brotli(bytes, options),
        "lz4" => compress_lz4_frame(bytes, options),
        "lz4-block" => compress_lz4_block(bytes, options),
        "xz" => compress_xz(bytes, options),
        "lzma" => compress_lzma(bytes, options),
        "lzma2" => compress_lzma2(bytes, options),
        "bzip2" | "zstd" => Err(err_with(
            "unsupported",
            json!({ "algorithm": algorithm, "detail": "decode-only algorithm" }),
        )),
        _ => Err(err_with(
            "unknown_algorithm",
            json!({ "algorithm": algorithm }),
        )),
    }
}

fn normalize(name: &str) -> String {
    match name.trim().to_ascii_lowercase().as_str() {
        "gzip" | "gz" => "gzip",
        "zlib" => "zlib",
        "deflate" | "raw-deflate" | "rawdeflate" => "deflate",
        "brotli" | "br" => "brotli",
        "lz4" | "lz4-frame" | "lz4frame" => "lz4",
        "lz4-block" | "lz4block" | "lz4-raw" => "lz4-block",
        "bzip2" | "bz2" => "bzip2",
        "xz" => "xz",
        "lzma" | "lzma-alone" | "lzma1" => "lzma",
        "lzma2" => "lzma2",
        "zstd" | "zst" => "zstd",
        other => other,
    }
    .to_string()
}

fn decompress_zstd(bytes: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    let window_cap = (options.max_output_bytes as u64).min(MAX_ZSTD_WINDOW_BYTES);
    let mut source = bytes;
    let mut out = Vec::with_capacity(
        options
            .expected_output_bytes
            .min(options.max_output_bytes)
            .min(HINT_CAP),
    );
    // ruzstd decodes one frame at a time; zstd files may legally concatenate
    // frames, so loop until the input is fully consumed. Anything left that is
    // not a valid frame fails rather than being silently ignored.
    while !source.is_empty() {
        let decoder = ruzstd::decoding::StreamingDecoder::new_with_max_window_size(
            &mut source,
            window_cap,
        )
        .map_err(|error| codec_error("decompress_failed", &error))?;
        read_into(decoder, &mut out, options.max_output_bytes, "decompress_failed")?;
    }
    Ok(out)
}

/// LZ4's frame decoder reports a clean end-of-stream when the input stops
/// mid-frame, so the frame structure is validated up front. The scan also
/// returns the declared content-size total when every frame carries one,
/// enabling an early `output_too_large` rejection before decoding.
fn decompress_lz4_frame(bytes: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    if let Some(declared) = lz4_frame_scan(bytes)? {
        if declared > options.max_output_bytes as u64 {
            return Err(err_with(
                "output_too_large",
                json!({ "limit": options.max_output_bytes, "declaredOutput": declared }),
            ));
        }
    }
    // FrameDecoder stops at each frame's end mark, so decode one frame at a
    // time and skip skippable frames explicitly. The structural scan above
    // already guaranteed every position decodes or skips cleanly.
    let mut source = bytes;
    let mut out = Vec::with_capacity(
        options
            .expected_output_bytes
            .min(options.max_output_bytes)
            .min(HINT_CAP),
    );
    while !source.is_empty() {
        if let Some(skip) = lz4_skippable_len(source) {
            source = &source[skip..];
            continue;
        }
        let before = source.len();
        let decoder = lz4_flex::frame::FrameDecoder::new(&mut source);
        read_into(decoder, &mut out, options.max_output_bytes, "decompress_failed")?;
        if source.len() == before {
            return Err(err_with(
                "decompress_failed",
                json!({ "detail": "lz4 decoder made no progress" }),
            ));
        }
    }
    Ok(out)
}

/// Length of a skippable frame at `input[0]` (`magic + u32 size + payload`),
/// or `None` when the leading magic is not a skippable frame. Callers must
/// have already bounds-checked the full span via `lz4_frame_scan`.
fn lz4_skippable_len(input: &[u8]) -> Option<usize> {
    if input.len() < 8 {
        return None;
    }
    let magic = u32::from_le_bytes(input[..4].try_into().unwrap());
    if !(0x184D_2A50..=0x184D_2A5F).contains(&magic) {
        return None;
    }
    let size = u32::from_le_bytes(input[4..8].try_into().unwrap()) as usize;
    Some(8 + size)
}

/// Walk every LZ4 frame in `input`, requiring the structure to consume the
/// input exactly: magic, FLG/BD header fields, optional content size and
/// dictionary id, each block's declared length, the end mark, and the
/// optional content checksum. Skippable frames (magic 0x184D2A50..=5F) are
/// skipped. Any shortfall is `truncated`; bad magic or a reserved FLG version
/// is `decompress_failed`.
fn lz4_frame_scan(input: &[u8]) -> Result<Option<u64>, String> {
    const LZ4_MAGIC: u32 = 0x184D_2204;
    const SKIPPABLE_MIN: u32 = 0x184D_2A50;
    const SKIPPABLE_MAX: u32 = 0x184D_2A5F;
    let need = |pos: usize, count: usize| -> Result<(), String> {
        if input.len().saturating_sub(pos) < count {
            return Err(err_with(
                "truncated",
                json!({ "detail": "lz4 frame ended before its declared structure" }),
            ));
        }
        Ok(())
    };
    let u32_at = |pos: usize| u32::from_le_bytes(input[pos..pos + 4].try_into().unwrap());

    let mut pos = 0usize;
    let mut frames = 0u32;
    let mut declared_total = 0u64;
    let mut all_declared = true;
    while pos < input.len() {
        need(pos, 4)?;
        let magic = u32_at(pos);
        if (SKIPPABLE_MIN..=SKIPPABLE_MAX).contains(&magic) {
            need(pos, 8)?;
            let skip = u32_at(pos + 4) as usize;
            pos += 8;
            need(pos, skip)?;
            pos += skip;
            continue;
        }
        if magic != LZ4_MAGIC {
            return Err(err_with(
                "decompress_failed",
                json!({ "detail": "invalid lz4 frame magic" }),
            ));
        }
        pos += 4;
        need(pos, 3)?; // FLG + BD + header checksum, minimum
        let flg = input[pos];
        if flg >> 6 != 0b01 {
            return Err(err_with(
                "decompress_failed",
                json!({ "detail": "unsupported lz4 frame version" }),
            ));
        }
        let block_checksum = flg & 0x10 != 0;
        let content_size_flag = flg & 0x08 != 0;
        let content_checksum = flg & 0x04 != 0;
        let dict_id = flg & 0x01 != 0;
        pos += 2;
        if content_size_flag {
            need(pos, 8)?;
            let declared = u64::from_le_bytes(input[pos..pos + 8].try_into().unwrap());
            declared_total = declared_total.checked_add(declared).ok_or_else(|| {
                err_with("output_too_large", json!({ "detail": "declared sizes overflow" }))
            })?;
            pos += 8;
        } else {
            all_declared = false;
        }
        if dict_id {
            need(pos, 4)?;
            pos += 4;
        }
        need(pos, 1)?; // header checksum byte
        pos += 1;
        loop {
            need(pos, 4)?;
            let block = u32_at(pos);
            pos += 4;
            if block == 0 {
                break; // EndMark
            }
            let size = (block & 0x7fff_ffff) as usize;
            need(pos, size)?;
            pos += size;
            if block_checksum {
                need(pos, 4)?;
                pos += 4;
            }
        }
        if content_checksum {
            need(pos, 4)?;
            pos += 4;
        }
        frames = frames.saturating_add(1);
    }
    if frames == 0 {
        return Err(err_with(
            "decompress_failed",
            json!({ "detail": "input contains only skippable frames" }),
        ));
    }
    Ok(all_declared.then_some(declared_total))
}

fn decompress_lz4_block(bytes: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    if bytes.len() < 4 {
        return Err(codec_error("decompress_failed", &"missing size prefix"));
    }
    let declared = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if declared > options.max_output_bytes {
        return Err(err_with(
            "output_too_large",
            json!({ "limit": options.max_output_bytes, "declaredOutput": declared }),
        ));
    }
    lz4_flex::decompress_size_prepended(bytes)
        .map_err(|error| codec_error("decompress_failed", &error))
}

fn lzma_options(options: &Options) -> lzma_rs::decompress::Options {
    lzma_rs::decompress::Options {
        unpacked_size: lzma_rs::decompress::UnpackedSize::ReadFromHeader,
        memlimit: Some(options.max_output_bytes.min(MAX_LZMA_DICT_BYTES)),
        allow_incomplete: false,
    }
}

fn decompress_lzma(bytes: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    let mut input = Cursor::new(bytes);
    let mut writer = BoundedWriter::new(options.max_output_bytes, options.expected_output_bytes);
    let result = lzma_rs::lzma_decompress_with_options(&mut input, &mut writer, &lzma_options(options));
    finish_bounded(writer, result, "decompress_failed")
}

fn decompress_lzma2(bytes: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    // LZMA2 chunk headers carry the exact unpacked size the decoder will emit,
    // so a clean pre-scan can reject oversized output before any allocation.
    if let Some(declared) = lzma2_declared_output(bytes) {
        if declared > options.max_output_bytes as u64 {
            return Err(err_with(
                "output_too_large",
                json!({ "limit": options.max_output_bytes, "declaredOutput": declared }),
            ));
        }
    }
    let mut input = Cursor::new(bytes);
    let mut writer = BoundedWriter::new(options.max_output_bytes, options.expected_output_bytes);
    let result = lzma_rs::lzma2_decompress(&mut input, &mut writer);
    finish_bounded(writer, result, "decompress_failed")
}

fn decompress_xz(bytes: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    // The xz index declares every block's uncompressed size; reject honest
    // bombs before decoding. The decoder re-verifies the index afterwards.
    if let Some(declared) = xz_declared_output(bytes) {
        if declared > options.max_output_bytes as u64 {
            return Err(err_with(
                "output_too_large",
                json!({ "limit": options.max_output_bytes, "declaredOutput": declared }),
            ));
        }
    }
    let mut input = Cursor::new(bytes);
    let mut writer = BoundedWriter::new(options.max_output_bytes, options.expected_output_bytes);
    let result = lzma_rs::xz_decompress(&mut input, &mut writer);
    finish_bounded(writer, result, "decompress_failed")
}

fn compress_deflate_family(
    algorithm: &str,
    bytes: &[u8],
    options: &Options,
) -> Result<Vec<u8>, String> {
    let level = flate2::Compression::new(options.level.unwrap_or(6).min(9));
    let mut writer = BoundedWriter::new(options.max_output_bytes, bytes.len() / 4);
    let outcome = (|| -> std::io::Result<()> {
        match normalize(algorithm).as_str() {
            "gzip" => {
                let mut encoder = flate2::write::GzEncoder::new(&mut writer, level);
                encoder.write_all(bytes)?;
                encoder.finish()?;
            }
            "zlib" => {
                let mut encoder = flate2::write::ZlibEncoder::new(&mut writer, level);
                encoder.write_all(bytes)?;
                encoder.finish()?;
            }
            _ => {
                let mut encoder = flate2::write::DeflateEncoder::new(&mut writer, level);
                encoder.write_all(bytes)?;
                encoder.finish()?;
            }
        }
        Ok(())
    })();
    finish_bounded(writer, outcome, "compress_failed")
}

fn compress_brotli(bytes: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    let quality = options.level.unwrap_or(5).min(11);
    let mut writer = BoundedWriter::new(options.max_output_bytes, bytes.len() / 2);
    {
        let mut encoder =
            brotli::CompressorWriter::new(&mut writer, BROTLI_BUFFER, quality, BROTLI_WINDOW);
        encoder
            .write_all(bytes)
            .map_err(|error| codec_error("compress_failed", &error))?;
        // Dropping the encoder finalizes the stream; a cap hit there only
        // surfaces through the writer flag below.
        drop(encoder);
    }
    if writer.hit_limit {
        return Err(err_with(
            "output_too_large",
            json!({ "limit": options.max_output_bytes }),
        ));
    }
    Ok(writer.into_inner())
}

fn compress_lz4_frame(bytes: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    let mut writer = BoundedWriter::new(options.max_output_bytes, bytes.len() / 2);
    let outcome = (|| -> Result<(), lz4_flex::frame::Error> {
        let mut encoder = lz4_flex::frame::FrameEncoder::new(&mut writer);
        encoder.write_all(bytes)?;
        encoder.finish()?;
        Ok(())
    })();
    finish_bounded(writer, outcome, "compress_failed")
}

fn compress_lz4_block(bytes: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    let result = lz4_flex::compress_prepend_size(bytes);
    if result.len() > options.max_output_bytes {
        return Err(err_with(
            "output_too_large",
            json!({ "limit": options.max_output_bytes }),
        ));
    }
    Ok(result)
}

fn compress_xz(bytes: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    let mut input = Cursor::new(bytes);
    let mut writer = BoundedWriter::new(options.max_output_bytes, bytes.len() / 2);
    let result = lzma_rs::xz_compress(&mut input, &mut writer);
    finish_bounded(writer, result, "compress_failed")
}

fn compress_lzma(bytes: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    let mut input = Cursor::new(bytes);
    let mut writer = BoundedWriter::new(options.max_output_bytes, bytes.len() / 2);
    let encode_options = lzma_rs::compress::Options {
        unpacked_size: lzma_rs::compress::UnpackedSize::WriteToHeader(Some(bytes.len() as u64)),
    };
    let result =
        lzma_rs::lzma_compress_with_options(&mut input, &mut writer, &encode_options);
    finish_bounded(writer, result, "compress_failed")
}

fn compress_lzma2(bytes: &[u8], options: &Options) -> Result<Vec<u8>, String> {
    let mut input = Cursor::new(bytes);
    let mut writer = BoundedWriter::new(options.max_output_bytes, bytes.len() / 2);
    let result = lzma_rs::lzma2_compress(&mut input, &mut writer);
    finish_bounded(writer, result, "compress_failed")
}

/// Walk LZMA2 chunk headers and sum the exact unpacked sizes the decoder will
/// produce. `None` when the stream is truncated or malformed — the real
/// decoder then decides with its own checks.
fn lzma2_declared_output(input: &[u8]) -> Option<u64> {
    let mut pos = 0usize;
    let mut total = 0u64;
    loop {
        let status = *input.get(pos)?;
        pos += 1;
        if status == 0 {
            return Some(total);
        }
        if status == 1 || status == 2 {
            let size = u16::from_be_bytes([*input.get(pos)?, *input.get(pos + 1)?]) as u64 + 1;
            pos = pos.checked_add(2 + size as usize)?;
            total = total.checked_add(size)?;
            if pos > input.len() {
                return None;
            }
        } else if status >= 0x80 {
            let unpacked =
                (((status as u64 & 0x1f) << 16) | u16::from_be_bytes([*input.get(pos)?, *input.get(pos + 1)?]) as u64) + 1;
            let packed =
                u16::from_be_bytes([*input.get(pos + 2)?, *input.get(pos + 3)?]) as u64 + 1;
            pos += 4;
            if (status >> 5) & 0x3 >= 2 {
                pos = pos.checked_add(1)?; // new properties byte
            }
            pos = pos.checked_add(packed as usize)?;
            total = total.checked_add(unpacked)?;
            if pos > input.len() {
                return None;
            }
        } else {
            return None;
        }
    }
}

/// Parse the xz stream footer and index to sum declared uncompressed sizes.
/// `None` when the layout is malformed; decoding then proceeds under the
/// writer cap and the module memory ceiling.
fn xz_declared_output(input: &[u8]) -> Option<u64> {
    const HEADER_LEN: usize = 12;
    const FOOTER_LEN: usize = 12;
    if input.len() < HEADER_LEN + FOOTER_LEN + 4 {
        return None;
    }
    if &input[..6] != b"\xfd7zXZ\x00" {
        return None;
    }
    let footer = &input[input.len() - FOOTER_LEN..];
    if &footer[10..12] != b"YZ" {
        return None;
    }
    let backward_size = u32::from_le_bytes([footer[4], footer[5], footer[6], footer[7]]) as u64;
    let index_size = backward_size.checked_add(1)?.checked_mul(4)? as usize;
    let index_start = input.len().checked_sub(FOOTER_LEN + index_size)?;
    if index_start < HEADER_LEN {
        return None;
    }
    let index = &input[index_start..input.len() - FOOTER_LEN];
    if index.first() != Some(&0) {
        return None;
    }
    let mut pos = 1usize;
    let records = xz_varint(index, &mut pos)?;
    let mut total = 0u64;
    for _ in 0..records {
        let _unpadded = xz_varint(index, &mut pos)?;
        let uncompressed = xz_varint(index, &mut pos)?;
        total = total.checked_add(uncompressed)?;
    }
    Some(total)
}

fn xz_varint(input: &[u8], pos: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *input.get(*pos)?;
        *pos += 1;
        if shift == 63 {
            return None;
        }
        value |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> Vec<u8> {
        // Repetitive but not trivial: exercises real compressor paths.
        let mut data = Vec::new();
        for i in 0..4096u32 {
            data.extend_from_slice(format!("record-{i:04}-payload-payload-payload\n").as_bytes());
        }
        data
    }

    fn expect_error(result: Result<Vec<u8>, String>) -> String {
        let error = result.expect_err("expected error");
        let parsed: serde_json::Value =
            serde_json::from_str(&error.to_string()).expect("error message is JSON");
        parsed["error"].as_str().unwrap_or("").to_string()
    }

    fn round_trip(algorithm: &str, options: &Options) {
        let input = payload();
        let compressed = compress(algorithm, &input, options).expect("compress");
        let restored = decompress(algorithm, &compressed, options).expect("decompress");
        assert_eq!(restored, input, "{algorithm} round trip");
    }

    #[test]
    fn round_trip_all_supported() {
        let options = Options::default();
        for algorithm in [
            "gzip", "zlib", "deflate", "brotli", "lz4", "lz4-block", "xz", "lzma", "lzma2",
        ] {
            round_trip(algorithm, &options);
        }
    }

    #[test]
    fn algorithm_aliases() {
        let options = Options::default();
        for (alias, canonical) in [
            ("gz", "gzip"),
            ("br", "brotli"),
            ("bz2", "bzip2"),
            ("zst", "zstd"),
            ("lzma-alone", "lzma"),
        ] {
            assert_eq!(normalize(alias), canonical);
        }
        assert_eq!(normalize(" LZ4 "), "lz4");
    }

    #[test]
    fn gzip_cross_member_stream() {
        // MultiGzDecoder must handle concatenated gzip members.
        let options = Options::default();
        let first = compress("gzip", b"hello ", &options).unwrap();
        let second = compress("gzip", b"world", &options).unwrap();
        let mut joined = first.clone();
        joined.extend_from_slice(&second);
        assert_eq!(decompress("gzip", &joined, &options).unwrap(), b"hello world");
    }

    #[test]
    fn gzip_decodes_reference_fixture() {
        // `printf 'turen codec fixture\n' | gzip -9 -n` — produced by the
        // reference zlib implementation, not by this crate.
        let fixture: [u8; 38] = [
            0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x03, 0x2b, 0x29, 0x2d, 0x4a,
            0xcd, 0x53, 0x48, 0xce, 0x4f, 0x49, 0x4d, 0x56, 0x48, 0xcb, 0xac, 0x28, 0x01, 0x72,
            0xb9, 0x00, 0x1a, 0x00, 0xc4, 0x69, 0x14, 0x00, 0x00, 0x00,
        ];
        let options = Options::default();
        let out = decompress("gzip", &fixture, &options).unwrap();
        assert_eq!(out, b"turen codec fixture\n");
        // zlib of the same payload produced by flate2's own encoder.
        let zlib = compress("zlib", b"turen codec fixture\n", &options).unwrap();
        assert_eq!(&zlib[..2], &[0x78, 0x9c]); // zlib CMF/FLG for level 6
        assert_eq!(
            decompress("zlib", &zlib, &options).unwrap(),
            b"turen codec fixture\n"
        );
    }

    #[test]
    fn zstd_decode_of_known_frame() {
        // ruzstd's own encoder builds the fixture; the public API stays
        // decode-only for zstd.
        let options = Options::default();
        let input = payload();
        let compressed = ruzstd::encoding::compress_to_vec(
            input.as_slice(),
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        assert!(compressed.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]));
        assert_eq!(decompress("zstd", &compressed, &options).unwrap(), input);
    }

    #[test]
    fn decode_only_algorithms_reject_compress() {
        let options = Options::default();
        for algorithm in ["zstd", "bzip2"] {
            assert_eq!(
                expect_error(compress(algorithm, b"data", &options)),
                "unsupported"
            );
        }
    }

    #[test]
    fn truncated_and_corrupt_inputs_fail_cleanly() {
        let options = Options::default();
        let input = payload();
        for algorithm in [
            "gzip", "zlib", "deflate", "brotli", "lz4", "lz4-block", "xz", "lzma", "lzma2",
        ] {
            let compressed = compress(algorithm, &input, &options).unwrap();
            for cut in [compressed.len() / 2, compressed.len() - 1] {
                let truncated = &compressed[..cut];
                let result = decompress(algorithm, truncated, &options);
                assert!(result.is_err(), "{algorithm} truncated input must fail");
                assert_ne!(
                    expect_error(result),
                    "",
                    "{algorithm} truncated input must report a code"
                );
            }
            let mut corrupt = compressed.clone();
            let mid = corrupt.len() / 2;
            corrupt[mid] ^= 0xff;
            // Bit corruption either fails or produces different bytes; it must
            // never panic and never silently return the original payload.
            if let Ok(out) = decompress(algorithm, &corrupt, &options) {
                assert_ne!(out, input, "{algorithm} corrupt input returned original");
            }
        }
    }

    #[test]
    fn truncated_decode_only_inputs_fail_cleanly() {
        // bzip2 and zstd have no local encoder; use reference fixtures and
        // ruzstd's own encoder respectively.
        let options = Options::default();
        let bz: &[u8] = &[
            0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0x66, 0x0f, 0xdb, 0x71,
            0x00, 0x00, 0x0a, 0xd9, 0x80, 0x00, 0x10, 0x40, 0x00, 0x10, 0x00, 0x1f, 0x21, 0xd6,
            0x50, 0x20, 0x00, 0x22, 0x26, 0x87, 0xa4, 0x30, 0x8f, 0x50, 0xa1, 0xa6, 0x98, 0x00,
            0x61, 0xc1, 0x0c, 0x16, 0x25, 0xd7, 0x06, 0x59, 0xeb, 0xc8, 0x7a, 0x53, 0x27, 0xe2,
            0xee, 0x48, 0xa7, 0x0a, 0x12, 0x0c, 0xc1, 0xfb, 0x6e, 0x20,
        ];
        for cut in [bz.len() / 2, bz.len() - 1] {
            assert!(
                decompress("bzip2", &bz[..cut], &options).is_err(),
                "bzip2 truncated at {cut} must fail"
            );
        }
        let input = payload();
        let zstd = ruzstd::encoding::compress_to_vec(
            input.as_slice(),
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        for cut in [zstd.len() / 2, zstd.len() - 1] {
            assert!(
                decompress("zstd", &zstd[..cut], &options).is_err(),
                "zstd truncated at {cut} must fail"
            );
        }
    }

    #[test]
    fn zstd_concatenated_frames_decode() {
        let options = Options::default();
        let first = ruzstd::encoding::compress_to_vec(
            b"hello ".as_slice(),
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        let second = ruzstd::encoding::compress_to_vec(
            b"world".as_slice(),
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        let mut joined = first;
        joined.extend_from_slice(&second);
        assert_eq!(
            decompress("zstd", &joined, &options).unwrap(),
            b"hello world"
        );
        // Trailing garbage after a complete frame is an error, not silence.
        joined.push(0xde);
        assert!(decompress("zstd", &joined, &options).is_err());
    }

    #[test]
    fn lz4_concatenated_and_skippable_frames() {
        let options = Options::default();
        let first = compress("lz4", b"hello ", &options).unwrap();
        let second = compress("lz4", b"world", &options).unwrap();
        let mut joined = first;
        joined.extend_from_slice(&second);
        assert_eq!(
            decompress("lz4", &joined, &options).unwrap(),
            b"hello world"
        );
        // Skippable frame: magic 0x184D2A50 + u32 size + payload.
        let mut with_skip = joined.clone();
        with_skip.extend_from_slice(&0x184D_2A50u32.to_le_bytes());
        with_skip.extend_from_slice(&3u32.to_le_bytes());
        with_skip.extend_from_slice(&[0xaa, 0xbb, 0xcc]);
        assert_eq!(
            decompress("lz4", &with_skip, &options).unwrap(),
            b"hello world"
        );
        // Trailing garbage fails: the scan requires exact consumption.
        with_skip.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        assert_eq!(
            expect_error(decompress("lz4", &with_skip, &options)),
            "decompress_failed"
        );
    }

    #[test]
    fn lz4_declared_content_size_pre_check() {
        let options = Options::default();
        let input = payload();
        let compressed = compress("lz4", &input, &options).unwrap();
        // lz4_flex's encoder writes FLG without a content-size field, so the
        // scan reports no declared total for its own output.
        assert_eq!(lz4_frame_scan(&compressed), Ok(None));
        // Hand-build a frame with the C.Size flag set and a huge declared
        // size; the scan rejects it before any decoding runs. The HC byte is
        // a header checksum the real decoder would check, but the scan only
        // walks structure.
        let mut frame = Vec::new();
        frame.extend_from_slice(&0x184D_2204u32.to_le_bytes());
        frame.push(0x68); // FLG: version 01, B.Indep 1, C.Size 1
        frame.push(0x40); // BD: 64KB max block
        frame.extend_from_slice(&(u64::MAX).to_le_bytes()); // declared content size
        frame.push(0x00); // HC (value not validated by the scan)
        frame.extend_from_slice(&0u32.to_le_bytes()); // EndMark
        assert_eq!(
            expect_error(decompress("lz4", &frame, &options)),
            "output_too_large"
        );
    }

    #[test]
    fn wrong_algorithm_is_an_error_not_a_panic() {
        let options = Options::default();
        let gzip_bytes = compress("gzip", &payload(), &options).unwrap();
        for algorithm in ["zlib", "deflate", "brotli", "lz4", "xz", "lzma", "lzma2", "zstd", "bzip2"] {
            let result = decompress(algorithm, &gzip_bytes, &options);
            assert!(result.is_err(), "{algorithm} on gzip input must fail");
        }
    }

    #[test]
    fn output_cap_is_enforced() {
        let options = Options {
            max_output_bytes: 1024,
            ..Options::default()
        };
        let input = payload();
        let compressed = compress("gzip", &input, &Options::default()).unwrap();
        assert!(input.len() > 1024);
        assert_eq!(
            expect_error(decompress("gzip", &compressed, &options)),
            "output_too_large"
        );
    }

    #[test]
    fn output_cap_partial_prefix_never_returned() {
        // maxOutputBytes smaller than the real output: error, no partial bytes.
        let options = Options {
            max_output_bytes: 5,
            ..Options::default()
        };
        let compressed = compress("gzip", &payload(), &Options::default()).unwrap();
        let result = decompress("gzip", &compressed, &options);
        assert_eq!(expect_error(result), "output_too_large");
    }

    #[test]
    fn lz4_block_declared_size_checked_before_allocation() {
        let mut fake = Vec::new();
        fake.extend_from_slice(&u32::MAX.to_le_bytes());
        fake.extend_from_slice(&[0u8; 32]);
        let options = Options::default();
        assert_eq!(
            expect_error(decompress("lz4-block", &fake, &options)),
            "output_too_large"
        );
    }

    #[test]
    fn lzma2_declared_output_pre_scan() {
        let options = Options::default();
        let input = payload();
        let compressed = compress("lzma2", &input, &options).unwrap();
        assert_eq!(lzma2_declared_output(&compressed), Some(input.len() as u64));
        let tiny = Options {
            max_output_bytes: 64,
            ..Options::default()
        };
        assert_eq!(
            expect_error(decompress("lzma2", &compressed, &tiny)),
            "output_too_large"
        );
    }

    #[test]
    fn xz_declared_output_pre_scan() {
        let options = Options::default();
        let input = payload();
        let compressed = compress("xz", &input, &options).unwrap();
        assert_eq!(xz_declared_output(&compressed), Some(input.len() as u64));
        let tiny = Options {
            max_output_bytes: 64,
            ..Options::default()
        };
        assert_eq!(
            expect_error(decompress("xz", &compressed, &tiny)),
            "output_too_large"
        );
    }

    #[test]
    fn pre_scans_do_not_panic_on_garbage() {
        let options = Options::default();
        let mut seed = 0x1234_5678u32;
        for _ in 0..512 {
            // Deterministic garbage covering lzma2 and xz pre-scanners.
            let mut garbage = vec![0u8; 128];
            for byte in garbage.iter_mut() {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                *byte = (seed >> 24) as u8;
            }
            garbage[0] = 0xfd;
            garbage[1] = 0x37;
            garbage[2] = 0x7a;
            garbage[3] = 0x58;
            garbage[4] = 0x5a;
            garbage[5] = 0x00;
            // Garbage must never panic; any result shape is acceptable.
            let _ = decompress("lzma2", &garbage, &options);
            let _ = decompress("xz", &garbage, &options);
            let _ = decompress("gzip", &garbage, &options);
            let _ = decompress("zstd", &garbage, &options);
            let _ = decompress("bzip2", &garbage, &options);
            let _ = decompress("brotli", &garbage, &options);
        }
    }

    #[test]
    fn determinism() {
        let options = Options::default();
        let input = payload();
        for algorithm in ["gzip", "zlib", "deflate", "brotli", "lz4", "lz4-block", "xz", "lzma", "lzma2"] {
            let a = compress(algorithm, &input, &options).unwrap();
            let b = compress(algorithm, &input, &options).unwrap();
            assert_eq!(a, b, "{algorithm} compression must be deterministic");
            let da = decompress(algorithm, &a, &options).unwrap();
            let db = decompress(algorithm, &a, &options).unwrap();
            assert_eq!(da, db, "{algorithm} decompression must be deterministic");
        }
    }

    #[test]
    fn compression_levels() {
        let input = payload();
        for level in [0u64, 1, 6, 9] {
            let options = Options {
                level: Some(level as u32),
                ..Options::default()
            };
            let compressed = compress("gzip", &input, &options).unwrap();
            assert_eq!(decompress("gzip", &compressed, &options).unwrap(), input);
        }
        let brotli_max = Options {
            level: Some(11),
            ..Options::default()
        };
        let compressed = compress("brotli", &input, &brotli_max).unwrap();
        assert_eq!(decompress("brotli", &compressed, &brotli_max).unwrap(), input);
        // Out-of-range levels clamp instead of failing.
        let huge = Options {
            level: Some(9999),
            ..Options::default()
        };
        assert!(compress("gzip", &input, &huge).is_ok());
    }

    #[test]
    fn expected_output_hint_is_accepted() {
        let options = Options {
            expected_output_bytes: 1 << 20,
            ..Options::default()
        };
        let compressed = compress("gzip", &payload(), &Options::default()).unwrap();
        assert!(decompress("gzip", &compressed, &options).is_ok());
    }

    #[test]
    fn bzip2_decodes_reference_fixture() {
        // `printf 'turen codec bzip2 fixture\n' | bzip2 -9` — produced by the
        // reference C implementation; bzip2 is decode-only in this crate.
        let fixture: [u8; 66] = [
            0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0x66, 0x0f, 0xdb, 0x71,
            0x00, 0x00, 0x0a, 0xd9, 0x80, 0x00, 0x10, 0x40, 0x00, 0x10, 0x00, 0x1f, 0x21, 0xd6,
            0x50, 0x20, 0x00, 0x22, 0x26, 0x87, 0xa4, 0x30, 0x8f, 0x50, 0xa1, 0xa6, 0x98, 0x00,
            0x61, 0xc1, 0x0c, 0x16, 0x25, 0xd7, 0x06, 0x59, 0xeb, 0xc8, 0x7a, 0x53, 0x27, 0xe2,
            0xee, 0x48, 0xa7, 0x0a, 0x12, 0x0c, 0xc1, 0xfb, 0x6e, 0x20,
        ];
        let options = Options::default();
        let out = decompress("bzip2", &fixture, &options).unwrap();
        assert_eq!(out, b"turen codec bzip2 fixture\n");
    }
}
