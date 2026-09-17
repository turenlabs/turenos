//! Bounded output sinks and readers. Limits are enforced while bytes flow so a
//! hostile stream never materializes beyond the cap.

use std::io::{self, Read, Write};

use serde_json::json;

use crate::{err_with, Options};

const READ_CHUNK: usize = 64 * 1024;
/// Ceiling applied to caller-provided output-size hints so a large
/// `expectedOutputBytes` cannot force a huge up-front allocation.
const HINT_MAX: usize = 4 * 1024 * 1024;

/// `Write` sink that fails once more than `limit` bytes would be produced.
/// `hit_limit` distinguishes our bound from underlying codec errors.
pub(crate) struct BoundedWriter {
    buf: Vec<u8>,
    limit: usize,
    pub(crate) hit_limit: bool,
}

impl BoundedWriter {
    pub(crate) fn new(limit: usize, hint: usize) -> Self {
        Self {
            buf: Vec::with_capacity(hint.min(limit).min(HINT_MAX)),
            limit,
            hit_limit: false,
        }
    }

    pub(crate) fn into_inner(self) -> Vec<u8> {
        self.buf
    }
}

impl Write for BoundedWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if data.len() > self.limit.saturating_sub(self.buf.len()) {
            self.hit_limit = true;
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "turen output limit reached",
            ));
        }
        self.buf.extend_from_slice(data);
        Ok(data.len())
    }

    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        if data.len() > self.limit.saturating_sub(self.buf.len()) {
            self.hit_limit = true;
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "turen output limit reached",
            ));
        }
        self.buf.extend_from_slice(data);
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Read a decoder to end-of-stream, aborting as soon as `limit` is exceeded.
/// The output buffer never exceeds `limit + READ_CHUNK` before the cap fires.
pub(crate) fn read_bounded<R: Read>(
    reader: R,
    options: &Options,
    failure: &'static str,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(
        options
            .expected_output_bytes
            .min(options.max_output_bytes)
            .min(HINT_MAX),
    );
    read_into(reader, &mut out, options.max_output_bytes, failure)?;
    Ok(out)
}

/// Append decoded chunks to `out` until the reader reports end-of-stream,
/// aborting the moment `limit` is exceeded. Used directly by decoders that
/// must be re-instantiated per frame (zstd concatenated frames).
pub(crate) fn read_into<R: Read>(
    mut reader: R,
    out: &mut Vec<u8>,
    limit: usize,
    failure: &'static str,
) -> Result<(), String> {
    let mut chunk = [0u8; READ_CHUNK];
    loop {
        if out.len() > limit {
            return Err(err_with("output_too_large", json!({ "limit": limit })));
        }
        let want = READ_CHUNK.min(limit + 1 - out.len());
        let read = reader
            .read(&mut chunk[..want])
            .map_err(|error| codec_error(failure, &error))?;
        if read == 0 {
            return Ok(());
        }
        out.extend_from_slice(&chunk[..read]);
    }
}

/// Map a codec-side failure to the shared error envelope.
pub(crate) fn codec_error(code: &'static str, error: &dyn std::fmt::Display) -> String {
    err_with(code, json!({ "detail": clean(&error.to_string()) }))
}

/// Result-of-write helper for `Write`-based codecs wrapping a `BoundedWriter`.
pub(crate) fn finish_bounded<E: std::fmt::Display>(
    writer: BoundedWriter,
    outcome: Result<(), E>,
    failure: &'static str,
) -> Result<Vec<u8>, String> {
    match outcome {
        Ok(()) if !writer.hit_limit => Ok(writer.into_inner()),
        _ if writer.hit_limit => Err(err_with(
            "output_too_large",
            json!({ "limit": writer.limit }),
        )),
        Err(error) => Err(codec_error(failure, &error)),
        Ok(()) => Err(err_with(
            "output_too_large",
            json!({ "limit": writer.limit }),
        )),
    }
}

fn clean(value: &str) -> String {
    value.chars().take(256).collect()
}
