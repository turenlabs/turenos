//! Bounds-checked little-endian readers shared by the AXML, DEX, ARSC-lite,
//! and ZIP-preamble scans. No function in this module panics: every read is
//! checked and returns `Option`, and decoders replace malformed sequences
//! with U+FFFD instead of indexing out of range.

/// Non-panicking cursor over a byte slice.
pub(crate) struct Reader<'a> {
    pub data: &'a [u8],
    pub pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn at(data: &'a [u8], pos: usize) -> Self {
        Self { data, pos }
    }

    pub fn skip(&mut self, count: usize) -> bool {
        match self.pos.checked_add(count) {
            Some(next) if next <= self.data.len() => {
                self.pos = next;
                true
            }
            _ => {
                self.pos = self.data.len();
                false
            }
        }
    }

    pub fn u8(&mut self) -> Option<u8> {
        let byte = *self.data.get(self.pos)?;
        self.pos += 1;
        Some(byte)
    }

    pub fn u16(&mut self) -> Option<u16> {
        let bytes: [u8; 2] = self.data.get(self.pos..self.pos + 2)?.try_into().ok()?;
        self.pos += 2;
        Some(u16::from_le_bytes(bytes))
    }

    pub fn u32(&mut self) -> Option<u32> {
        let bytes: [u8; 4] = self.data.get(self.pos..self.pos + 4)?.try_into().ok()?;
        self.pos += 4;
        Some(u32::from_le_bytes(bytes))
    }

    #[allow(dead_code)]
    pub fn u64(&mut self) -> Option<u64> {
        let bytes: [u8; 8] = self.data.get(self.pos..self.pos + 8)?.try_into().ok()?;
        self.pos += 8;
        Some(u64::from_le_bytes(bytes))
    }

    pub fn bytes(&mut self, count: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(count)?;
        let slice = self.data.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }

    /// DEX uleb128: at most 5 bytes, value must fit in u32.
    pub fn uleb128(&mut self) -> Option<u32> {
        let mut value: u32 = 0;
        for shift in (0..=28).step_by(7) {
            let byte = self.u8()?;
            let payload = (byte & 0x7f) as u32;
            if shift == 28 && payload > 0x0f {
                return None; // would overflow u32
            }
            value |= payload << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }
}

/// Decode a DEX MUTF-8 string body (bytes up to, not including, the NUL
/// terminator). Modified UTF-8 encodes NUL as `C0 80` and supplementary
/// characters as CESU-8 surrogate pairs. Malformed sequences decode as
/// U+FFFD and resynchronize at the next byte.
pub(crate) fn mutf8_to_string(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let b0 = bytes[i];
        if b0 == 0 {
            break; // embedded NUL terminates
        } else if b0 < 0x80 {
            out.push(b0 as char);
            i += 1;
        } else if (0xc0..0xe0).contains(&b0) {
            let b1 = *bytes.get(i + 1).unwrap_or(&0);
            if b1 & 0xc0 != 0x80 {
                out.push('\u{fffd}');
                i += 1;
                continue;
            }
            let unit = (((b0 & 0x1f) as u32) << 6) | (b1 & 0x3f) as u32;
            out.push(char::from_u32(unit).unwrap_or('\u{fffd}'));
            i += 2;
        } else if (0xe0..0xf0).contains(&b0) {
            let b1 = *bytes.get(i + 1).unwrap_or(&0);
            let b2 = *bytes.get(i + 2).unwrap_or(&0);
            if b1 & 0xc0 != 0x80 || b2 & 0xc0 != 0x80 {
                out.push('\u{fffd}');
                i += 1;
                continue;
            }
            let unit =
                (((b0 & 0x0f) as u32) << 12) | (((b1 & 0x3f) as u32) << 6) | (b2 & 0x3f) as u32;
            i += 3;
            if (0xd800..0xdc00).contains(&unit) {
                // Try to combine with a following CESU-8 low surrogate.
                if i + 2 < bytes.len()
                    && (0xe0..0xf0).contains(&bytes[i])
                    && bytes[i + 1] & 0xc0 == 0x80
                    && bytes[i + 2] & 0xc0 == 0x80
                {
                    let low = (((bytes[i] & 0x0f) as u32) << 12)
                        | (((bytes[i + 1] & 0x3f) as u32) << 6)
                        | (bytes[i + 2] & 0x3f) as u32;
                    if (0xdc00..0xe000).contains(&low) {
                        let code = 0x10000 + (((unit - 0xd800) << 10) | (low - 0xdc00));
                        out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                        i += 3;
                        continue;
                    }
                }
                out.push('\u{fffd}');
            } else {
                out.push(char::from_u32(unit).unwrap_or('\u{fffd}'));
            }
        } else {
            out.push('\u{fffd}');
            i += 1;
        }
    }
    out
}

/// Decode UTF-16LE units with replacement for unpaired surrogates.
pub(crate) fn utf16_to_string(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|item| item.unwrap_or('\u{fffd}'))
        .collect()
}

/// Truncate a string to at most `max_chars` characters (char-boundary safe).
pub(crate) fn cap_str(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max_chars).collect();
    out.push('\u{2026}');
    out
}

/// Escape text content for XML output (`&`, `<`, `>`).
pub(crate) fn escape_xml_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// Escape an attribute value for XML output (additionally `"` and `'`).
pub(crate) fn escape_xml_attr(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

/// Lowercase hex without separators.
pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}
