//! `wasm_print`: bounded wasm/component -> `.wat` text rendering.

use crate::{encoding_of, error_json, Options};
use std::io;
use wasmprinter::Print;

/// `wasmprinter::Print` sink that stops the printer once `limit` bytes have
/// been written. Exceeding the cap returns an I/O error which aborts the
/// printer immediately, so output work stays proportional to the cap rather
/// than to the input size.
struct BoundedPrint {
    buffer: String,
    limit: usize,
    truncated: bool,
}

impl BoundedPrint {
    fn exceeded() -> io::Error {
        io::Error::new(io::ErrorKind::Other, "turen_wat_output_limit")
    }
}

impl Print for BoundedPrint {
    fn write_str(&mut self, text: &str) -> io::Result<()> {
        if self.truncated {
            return Err(Self::exceeded());
        }
        let remaining = self.limit.saturating_sub(self.buffer.len());
        if text.len() <= remaining {
            self.buffer.push_str(text);
            return Ok(());
        }
        // Keep the truncated prefix valid UTF-8.
        let mut end = remaining;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        self.buffer.push_str(&text[..end]);
        self.truncated = true;
        Err(Self::exceeded())
    }
}

pub(crate) fn print(bytes: &[u8], options: &Options) -> String {
    let encoding = encoding_of(bytes);
    if encoding == "unknown" {
        return error_json("not_a_wasm_module");
    }

    let mut config = wasmprinter::Config::new();
    config
        .print_skeleton(options.skeleton)
        .fold_instructions(options.fold_expressions)
        .print_offsets(options.print_offsets)
        .name_unnamed(true);

    let mut sink = BoundedPrint {
        buffer: String::new(),
        limit: options.max_wat_bytes(),
        truncated: false,
    };
    if let Err(error) = config.print(bytes, &mut sink) {
        if !sink.truncated {
            return crate::error_json_detail(
                "print_failed",
                serde_json::json!({ "message": error.to_string() }),
            );
        }
    }

    // The wat text itself is the bounded payload (<= 8 MiB); the JSON envelope
    // adds escaping overhead, so the serialized string gets its own cap of
    // 12 MiB instead of the generic 4 MiB report bound. Pathological escaping
    // (text that is mostly quotes/control bytes) can still exceed it, in which
    // case the payload is re-truncated once and marked truncated.
    const MAX_PRINT_JSON_BYTES: usize = 12 * 1024 * 1024;
    let mut truncated = sink.truncated;
    let mut wat = sink.buffer;
    let mut output = print_json(bytes.len(), encoding, &wat, truncated);
    if output.len() > MAX_PRINT_JSON_BYTES {
        truncated = true;
        // `String::truncate` requires a char boundary; floor to one first.
        let mut reduced = wat.len().min(1024 * 1024);
        while reduced > 0 && !wat.is_char_boundary(reduced) {
            reduced -= 1;
        }
        wat.truncate(reduced);
        output = print_json(bytes.len(), encoding, &wat, truncated);
        if output.len() > MAX_PRINT_JSON_BYTES {
            return error_json("output_too_large");
        }
    }
    output
}

fn print_json(input_bytes: usize, encoding: &str, wat: &str, truncated: bool) -> String {
    serde_json::json!({
        "schema_version": 1,
        "input_bytes": input_bytes,
        "encoding": encoding,
        "wat": wat,
        "wat_bytes": wat.len(),
        "truncated": truncated,
    })
    .to_string()
}
