//! bsdiff-style binary diff producing the `bipatch` wire format.
//!
//! The scan is a single-threaded port of `BsdiffIterator` and `Translator`
//! from divvun/bidiff 1.0.0 (Apache-2.0 OR MIT), itself derived from Colin
//! Percival's bsdiff. Upstream drives the match search through rayon
//! partitions and `Instant` timing, neither of which runs under
//! wasm32-unknown-unknown; this port searches a single `divsufsort` suffix
//! array directly. Scores use `isize` like the original C implementation so
//! the `oldscore` bookkeeping can never wrap.
//!
//! Wire format (read back by the `bipatch` crate):
//! ```text
//! u32le magic   = 0xB1DF
//! u32le version = 0x1000
//! repeat until EOF:
//!   varint add_len | add_len diff bytes
//!   varint copy_len | copy_len literal bytes
//!   varint seek (signed)
//! ```

use std::io::Write;

use byteorder::{LittleEndian, WriteBytesExt};
use integer_encoding::VarIntWriter;
use sacabase::StringIndex;

use crate::{err, err_with};
use serde_json::json;

const MAGIC: u32 = 0xB1DF;
const VERSION: u32 = 0x1000;

/// One bsdiff match: an "add" (byte-wise difference) region followed by a
/// "copy" (literal new bytes) region. `copy_start()` is implied.
struct Match {
    add_old_start: usize,
    add_new_start: usize,
    add_length: usize,
    copy_end: usize,
}

impl Match {
    fn copy_start(&self) -> usize {
        self.add_new_start + self.add_length
    }
}

/// Emit the patch for `old` -> `new` into a fresh vector bounded by `max`.
pub(crate) fn diff(old: &[u8], new: &[u8], max: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    write_header(&mut out, max)?;

    if new.is_empty() {
        // A header-only patch applies to an empty output for any `old`.
        return Ok(out);
    }
    if old.is_empty() {
        // No suffix array over an empty buffer; the whole of `new` is one
        // literal copy region.
        return write_control(&mut out, max, &[], new, 0).map(|()| out);
    }

    let sa = divsufsort::sort(old);
    let mut translator = Translator::new(old, new, &mut out, max);
    for m in Scanner::new(old, new, &sa) {
        translator.translate(m)?;
    }
    translator.close()?;
    Ok(out)
}

fn write_header(out: &mut Vec<u8>, max: usize) -> Result<(), String> {
    if out.len() + 8 > max {
        return Err(err("output_too_large"));
    }
    out.write_u32::<LittleEndian>(MAGIC)
        .and_then(|()| out.write_u32::<LittleEndian>(VERSION))
        .map_err(|_| err("internal_error"))
}

fn write_control(
    out: &mut Vec<u8>,
    max: usize,
    add: &[u8],
    copy: &[u8],
    seek: i64,
) -> Result<(), String> {
    // Five bytes per varint is the worst case for a u32 length; seek is a
    // signed i64 varint and needs at most ten.
    if out.len() + add.len() + copy.len() + 20 > max {
        return Err(err_with(
            "output_too_large",
            json!({ "limit": max }),
        ));
    }
    out.write_varint(add.len())
        .and_then(|_| out.write_all(add))
        .and_then(|_| out.write_varint(copy.len()))
        .and_then(|_| out.write_all(copy))
        .and_then(|_| out.write_varint(seek))
        .map(|_| ())
        .map_err(|_| err("internal_error"))
}

/// Accumulates diff bytes for the pending match's add region and flushes one
/// control record per match, exactly like upstream `Translator`.
struct Translator<'a> {
    obuf: &'a [u8],
    nbuf: &'a [u8],
    buf: Vec<u8>,
    prev_match: Option<Match>,
    out: &'a mut Vec<u8>,
    max: usize,
    closed: bool,
}

impl<'a> Translator<'a> {
    fn new(obuf: &'a [u8], nbuf: &'a [u8], out: &'a mut Vec<u8>, max: usize) -> Self {
        Self {
            obuf,
            nbuf,
            buf: Vec::with_capacity(16 * 1024),
            prev_match: None,
            out,
            max,
            closed: false,
        }
    }

    fn send_control(&mut self, m: Option<&Match>) -> Result<(), String> {
        if let Some(pm) = self.prev_match.take() {
            let copy_start = pm.copy_start().min(pm.copy_end);
            let seek = match m {
                Some(m) => m.add_old_start as i64 - (pm.add_old_start + pm.add_length) as i64,
                None => 0,
            };
            write_control(
                self.out,
                self.max,
                &self.buf[..pm.add_length],
                &self.nbuf[copy_start..pm.copy_end],
                seek,
            )?;
        }
        Ok(())
    }

    fn translate(&mut self, m: Match) -> Result<(), String> {
        self.send_control(Some(&m))?;
        self.buf.clear();
        // add bytes are the wrapping difference between the matched regions.
        let (obuf, nbuf) = (self.obuf, self.nbuf);
        self.buf.extend(
            (0..m.add_length)
                .map(|i| nbuf[m.add_new_start + i].wrapping_sub(obuf[m.add_old_start + i])),
        );
        self.prev_match = Some(m);
        Ok(())
    }

    fn close(mut self) -> Result<(), String> {
        if !self.closed {
            self.send_control(None)?;
            self.closed = true;
        }
        Ok(())
    }
}

/// The bsdiff scan over `new`, consulting a suffix array of `old` for the
/// longest substring match at each scan position.
struct Scanner<'a> {
    scan: usize,
    pos: usize,
    length: usize,
    lastscan: usize,
    lastpos: usize,
    lastoffset: isize,
    obuf: &'a [u8],
    nbuf: &'a [u8],
    sa: &'a dyn StringIndex<'a>,
}

impl<'a> Scanner<'a> {
    fn new(obuf: &'a [u8], nbuf: &'a [u8], sa: &'a dyn StringIndex<'a>) -> Self {
        Self {
            scan: 0,
            pos: 0,
            length: 0,
            lastscan: 0,
            lastpos: 0,
            lastoffset: 0,
            obuf,
            nbuf,
            sa,
        }
    }
}

impl<'a> Iterator for Scanner<'a> {
    type Item = Match;

    fn next(&mut self) -> Option<Self::Item> {
        let obuflen = self.obuf.len();
        let nbuflen = self.nbuf.len();

        while self.scan < nbuflen {
            let mut oldscore = 0_isize;
            self.scan += self.length;

            let mut scsc = self.scan;
            'inner: while self.scan < nbuflen {
                let res = self.sa.longest_substring_match(&self.nbuf[self.scan..]);
                self.pos = res.start;
                self.length = res.len;

                while scsc < self.scan + self.length {
                    let oi = (scsc as isize + self.lastoffset) as usize;
                    if oi < obuflen && self.obuf[oi] == self.nbuf[scsc] {
                        oldscore += 1;
                    }
                    scsc += 1;
                }

                let significantly_better = self.length as isize > oldscore + 8;
                let same_length = self.length as isize == oldscore && self.length != 0;

                if same_length || significantly_better {
                    break 'inner;
                }

                let oi = (self.scan as isize + self.lastoffset) as usize;
                if oi < obuflen && self.obuf[oi] == self.nbuf[self.scan] {
                    oldscore -= 1;
                }

                self.scan += 1;
            }

            let done_scanning = self.scan == nbuflen;
            if self.length as isize != oldscore || done_scanning {
                // length forward from lastscan
                let mut lenf = {
                    let (mut s, mut sf, mut lenf) = (0_isize, 0_isize, 0_isize);
                    let bound = (self.scan - self.lastscan).min(obuflen - self.lastpos);
                    for i in 0..bound {
                        if self.obuf[self.lastpos + i] == self.nbuf[self.lastscan + i] {
                            s += 1;
                        }
                        let i = i as isize + 1;
                        if s * 2 - i > sf * 2 - lenf {
                            sf = s;
                            lenf = i;
                        }
                    }
                    lenf as usize
                };

                // length backwards from scan
                let mut lenb = if self.scan >= nbuflen {
                    0
                } else {
                    let (mut s, mut sb, mut lenb) = (0_isize, 0_isize, 0_isize);
                    for i in 1..=(self.scan - self.lastscan).min(self.pos) {
                        if self.obuf[self.pos - i] == self.nbuf[self.scan - i] {
                            s += 1;
                        }
                        let i = i as isize;
                        if s * 2 - i > sb * 2 - lenb {
                            sb = s;
                            lenb = i;
                        }
                    }
                    lenb as usize
                };

                if self.lastscan + lenf > self.scan - lenb {
                    // The previous scan reaches forward more than the current
                    // scan reaches back; split the overlap by score.
                    let overlap = (self.lastscan + lenf) - (self.scan - lenb);
                    let lens = {
                        let (mut s, mut ss, mut lens) = (0_isize, 0_isize, 0_usize);
                        for i in 0..overlap {
                            if self.nbuf[self.lastscan + lenf - overlap + i]
                                == self.obuf[self.lastpos + lenf - overlap + i]
                            {
                                s += 1;
                            }
                            if self.nbuf[self.scan - lenb + i] == self.obuf[self.pos - lenb + i] {
                                s -= 1;
                            }
                            if s > ss {
                                ss = s;
                                lens = i + 1;
                            }
                        }
                        lens
                    };
                    lenf += lens;
                    lenf -= overlap;
                    lenb -= lens;
                }

                let m = Match {
                    add_old_start: self.lastpos,
                    add_new_start: self.lastscan,
                    add_length: lenf,
                    copy_end: self.scan - lenb,
                };

                self.lastscan = self.scan - lenb;
                self.lastpos = self.pos - lenb;
                self.lastoffset = self.pos as isize - self.scan as isize;

                return Some(m);
            }
        }

        None
    }
}
