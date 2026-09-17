//! Git delta application (the `ofs-delta`/`ref-delta` payload format).
//!
//! A delta stream is: base-size varint, result-size varint, then opcodes.
//! Opcode MSB set = copy from base (offset/size assembled from flag bits);
//! otherwise the opcode byte is a literal insert count. All bounds are checked
//! before copying so malformed deltas error instead of panicking.

/// Decode a git varint (7-bit groups, little-endian, MSB continuation).
/// Returns (value, next position).
fn read_size(data: &[u8], mut pos: usize) -> Result<(u64, usize), &'static str> {
    let mut value = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *data.get(pos).ok_or("malformed_delta")?;
        pos += 1;
        value |= ((byte & 0x7f) as u64) << shift;
        shift += 7;
        if byte & 0x80 == 0 {
            return Ok((value, pos));
        }
        if shift > 63 {
            return Err("malformed_delta");
        }
    }
}

/// Apply `delta` to `base`, allocating at most `out_cap` bytes.
pub(crate) fn apply_delta(
    base: &[u8],
    delta: &[u8],
    out_cap: usize,
) -> Result<Vec<u8>, &'static str> {
    let (base_size, mut pos) = read_size(delta, 0)?;
    if base_size != base.len() as u64 {
        return Err("delta_base_mismatch");
    }
    let (result_size, next) = read_size(delta, pos)?;
    pos = next;
    if result_size > out_cap as u64 {
        return Err("object_too_large");
    }
    let mut out = Vec::with_capacity(result_size as usize);
    while pos < delta.len() {
        let cmd = delta[pos];
        pos += 1;
        if cmd & 0x80 != 0 {
            // Copy from base: flag bits select which offset/size bytes follow.
            let mut offset = 0u64;
            let mut size = 0u64;
            for bit in 0..4 {
                if cmd & (1 << bit) != 0 {
                    let byte = *delta.get(pos).ok_or("malformed_delta")?;
                    pos += 1;
                    offset |= (byte as u64) << (8 * bit);
                }
            }
            for bit in 0..3 {
                if cmd & (0x10 << bit) != 0 {
                    let byte = *delta.get(pos).ok_or("malformed_delta")?;
                    pos += 1;
                    size |= (byte as u64) << (8 * bit);
                }
            }
            if size == 0 {
                size = 0x10000;
            }
            let offset = usize::try_from(offset).map_err(|_| "malformed_delta")?;
            let size = usize::try_from(size).map_err(|_| "malformed_delta")?;
            let end = offset.checked_add(size).ok_or("malformed_delta")?;
            if end > base.len() {
                return Err("malformed_delta");
            }
            out.extend_from_slice(&base[offset..end]);
            if out.len() > result_size as usize {
                return Err("malformed_delta");
            }
        } else if cmd != 0 {
            let end = pos.checked_add(cmd as usize).ok_or("malformed_delta")?;
            if end > delta.len() {
                return Err("malformed_delta");
            }
            out.extend_from_slice(&delta[pos..end]);
            pos = end;
            if out.len() > result_size as usize {
                return Err("malformed_delta");
            }
        } else {
            return Err("malformed_delta");
        }
    }
    if out.len() != result_size as usize {
        return Err("malformed_delta");
    }
    Ok(out)
}
