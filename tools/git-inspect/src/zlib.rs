//! Bounded zlib inflation shared by loose objects and packfile entry streams.
//!
//! Every inflater runs the stream to `Status::StreamEnd` so callers learn the
//! exact number of input bytes a stream consumed; that is how packfile entry
//! boundaries are found. Output is capped before allocation: buffers grow in
//! bounded steps and never exceed the caller's limit.

use flate2::{Decompress, FlushDecompress, Status};

/// Result of a bounded inflate that keeps the produced bytes.
pub(crate) struct Inflated {
    pub data: Vec<u8>,
    /// Input bytes consumed by the zlib stream, including its trailer.
    pub consumed: usize,
    /// True when the stream reached its end marker; false when `cap` hit first.
    pub complete: bool,
}

/// Result of a bounded inflate that only measures the stream (output discarded).
pub(crate) struct Measured {
    /// Total decompressed bytes the stream produced.
    pub out_len: u64,
    pub consumed: usize,
}

/// Inflate `input` as a zlib (RFC 1950) stream, keeping at most `cap` bytes.
///
/// Returns `"zlib_error"` for malformed streams and `"truncated_zlib"` when the
/// input ends before the stream does. When the output cap is reached the result
/// is `complete: false` with exactly `cap` bytes retained.
pub(crate) fn inflate_bounded(input: &[u8], cap: usize) -> Result<Inflated, &'static str> {
    if cap == 0 {
        return Ok(Inflated {
            data: Vec::new(),
            consumed: 0,
            complete: false,
        });
    }
    let mut dec = Decompress::new(true);
    let mut data = vec![0u8; cap.min(64 * 1024)];
    let mut consumed = 0usize;
    let mut filled = 0usize;
    loop {
        let prev_in = dec.total_in();
        let prev_out = dec.total_out();
        let status = dec
            .decompress(&input[consumed..], &mut data[filled..], FlushDecompress::None)
            .map_err(|_| "zlib_error")?;
        consumed = dec.total_in() as usize;
        filled = dec.total_out() as usize;
        if status == Status::StreamEnd {
            data.truncate(filled);
            return Ok(Inflated {
                data,
                consumed,
                complete: true,
            });
        }
        if filled == data.len() {
            if data.len() >= cap {
                // The buffer is full at the cap: probe with an empty output
                // slice so the decoder can still consume the zlib trailer and
                // report StreamEnd for a stream that produced exactly `cap`.
                match dec.decompress(&input[consumed..], &mut [], FlushDecompress::None) {
                    Ok(Status::StreamEnd) => {
                        data.truncate(cap);
                        return Ok(Inflated {
                            data,
                            consumed: dec.total_in() as usize,
                            complete: true,
                        });
                    }
                    _ => {
                        data.truncate(cap);
                        return Ok(Inflated {
                            data,
                            consumed,
                            complete: false,
                        });
                    }
                }
            }
            let grown = (data.len() * 4).min(cap);
            data.resize(grown, 0);
            continue;
        }
        if consumed == input.len() {
            return Err("truncated_zlib");
        }
        if dec.total_in() == prev_in && dec.total_out() == prev_out {
            // No forward progress with input and output space available.
            return Err("zlib_error");
        }
    }
}

/// Run a zlib stream to its end while discarding output, counting produced
/// bytes. Used by packfile scanning where only the consumed-byte boundary and
/// the declared-size check matter; `out_limit` bounds the CPU spent on hostile
/// compression bombs. Returns `"decompress_limit"` when `out_limit` is reached
/// before the stream ends.
pub(crate) fn inflate_measure(input: &[u8], out_limit: u64) -> Result<Measured, &'static str> {
    let mut dec = Decompress::new(true);
    let mut scratch = [0u8; 64 * 1024];
    let mut consumed = 0usize;
    loop {
        let prev_in = dec.total_in();
        let prev_out = dec.total_out();
        let status = dec
            .decompress(&input[consumed..], &mut scratch, FlushDecompress::None)
            .map_err(|_| "zlib_error")?;
        consumed = dec.total_in() as usize;
        let produced = dec.total_out();
        if status == Status::StreamEnd {
            return Ok(Measured {
                out_len: produced,
                consumed,
            });
        }
        // `>` not `>=`: a stream producing exactly out_limit may still be
        // mid-trailer; give it one more pass to reach StreamEnd.
        if produced > out_limit {
            return Err("decompress_limit");
        }
        if consumed == input.len() {
            return Err("truncated_zlib");
        }
        if dec.total_in() == prev_in && dec.total_out() == prev_out {
            return Err("zlib_error");
        }
    }
}
