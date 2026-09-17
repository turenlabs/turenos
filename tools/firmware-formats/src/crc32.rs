//! CRC-32 (IEEE 802.3, polynomial 0xEDB88320, init/xorout 0xFFFFFFFF).
//!
//! Hand-rolled const table; used by the U-Boot uImage, U-Boot environment,
//! and Android sparse image checksums — all three use the same CRC.

const fn make_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut cell = i as u32;
        let mut bit = 0;
        while bit < 8 {
            cell = if cell & 1 != 0 {
                0xEDB8_8320 ^ (cell >> 1)
            } else {
                cell >> 1
            };
            bit += 1;
        }
        table[i] = cell;
        i += 1;
    }
    table
}

static TABLE: [u32; 256] = make_table();

pub(crate) fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc = (crc >> 8) ^ TABLE[((crc ^ byte as u32) & 0xFF) as usize];
    }
    !crc
}
