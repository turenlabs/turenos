use serde::Serialize;
use std::io::Cursor;
use wasm_bindgen::prelude::*;

const MAX_INPUT: usize = 32 * 1024 * 1024;
const MAX_OUTPUT: usize = 128 * 1024 * 1024;

#[derive(Clone, Copy)]
enum Compression {
    Lzma,
    Lzmat,
}

#[derive(Clone, Copy)]
struct Stub {
    name: &'static str,
    signature: u32,
    packed_offset: usize,
    fix_offset: usize,
    reloc_offset: usize,
    reloc_size_offset: usize,
    compression: Compression,
}

const STUBS: [Stub; 7] = [
    Stub {
        name: "1.01-1.05",
        signature: 0x2b6,
        packed_offset: 0x2bc,
        fix_offset: 0x2b8,
        reloc_offset: 0x2c8,
        reloc_size_offset: 0x2c0,
        compression: Compression::Lzmat,
    },
    Stub {
        name: "1.07-1.27",
        signature: 0x29e,
        packed_offset: 0x2a4,
        fix_offset: 0x2a0,
        reloc_offset: 0x2b0,
        reloc_size_offset: 0x2a8,
        compression: Compression::Lzmat,
    },
    Stub {
        name: "2.01",
        signature: 0x299,
        packed_offset: 0x29f,
        fix_offset: 0x29b,
        reloc_offset: 0x2ab,
        reloc_size_offset: 0x2a3,
        compression: Compression::Lzmat,
    },
    Stub {
        name: "2.05-lzma",
        signature: 0xb57,
        packed_offset: 0xb5d,
        fix_offset: 0xb59,
        reloc_offset: 0xb61,
        reloc_size_offset: 0xb69,
        compression: Compression::Lzma,
    },
    Stub {
        name: "2.05-lzmat",
        signature: 0x29c,
        packed_offset: 0x2a2,
        fix_offset: 0x29e,
        reloc_offset: 0x2a6,
        reloc_size_offset: 0x2ae,
        compression: Compression::Lzmat,
    },
    Stub {
        name: "2.12-2.19-lzma",
        signature: 0xb5a,
        packed_offset: 0xb60,
        fix_offset: 0xb5c,
        reloc_offset: 0xb64,
        reloc_size_offset: 0xb6c,
        compression: Compression::Lzma,
    },
    Stub {
        name: "2.12-2.19-lzmat",
        signature: 0x29f,
        packed_offset: 0x2a5,
        fix_offset: 0x2a1,
        reloc_offset: 0x2a9,
        reloc_size_offset: 0x2b1,
        compression: Compression::Lzmat,
    },
];

#[derive(Clone)]
struct Section {
    header_offset: usize,
    virtual_size: u32,
    virtual_address: u32,
    raw_size: u32,
    raw_offset: u32,
}

struct Pe {
    optional_offset: usize,
    entry_rva: u32,
    file_alignment: u32,
    section_alignment: u32,
    sections: Vec<Section>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    detected: bool,
    packer: Option<&'static str>,
    version: Option<&'static str>,
    method: Option<&'static str>,
    supported: bool,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    packer: &'static str,
    version: &'static str,
    method: &'static str,
    original_size: usize,
    output_size: usize,
    entry_point: String,
    imports_rebuilt: bool,
    runnable: bool,
}

#[wasm_bindgen]
pub fn probe(bytes: &[u8]) -> Result<String, JsError> {
    if bytes.windows(4).any(|window| window == b"UPX!") {
        return Ok(serde_json::to_string(&Probe {
            detected: true,
            packer: Some("upx"),
            version: None,
            method: None,
            supported: true,
            error: None,
        })
        .unwrap());
    }
    let result = parse_pe(bytes)
        .and_then(|pe| detect_stub(bytes, &pe).map(|(_, stub)| stub))
        .map(|stub| Probe {
            detected: true,
            packer: Some("mpress"),
            version: Some(stub.name),
            method: Some(method_name(stub.compression)),
            supported: true,
            error: None,
        })
        .unwrap_or_else(|error| Probe {
            detected: false,
            packer: None,
            version: None,
            method: None,
            supported: false,
            error: Some(error),
        });
    serde_json::to_string(&result).map_err(|error| JsError::new(&error.to_string()))
}

#[wasm_bindgen]
pub fn unpack_mpress(bytes: &[u8]) -> Result<Vec<u8>, JsError> {
    unpack(bytes)
        .map(|value| value.0)
        .map_err(|error| JsError::new(&error))
}

#[wasm_bindgen]
pub fn unpack_mpress_metadata(bytes: &[u8]) -> Result<String, JsError> {
    let metadata = unpack(bytes)
        .map(|value| value.1)
        .map_err(|error| JsError::new(&error))?;
    serde_json::to_string(&metadata).map_err(|error| JsError::new(&error.to_string()))
}

fn unpack(bytes: &[u8]) -> Result<(Vec<u8>, Metadata), String> {
    if bytes.len() > MAX_INPUT {
        return Err("input exceeds 32 MiB limit".into());
    }
    let pe = parse_pe(bytes)?;
    let (entry_offset, stub) = detect_stub(bytes, &pe)?;
    let packed_target = relative_target(
        pe.entry_rva,
        stub.packed_offset,
        read_i32(bytes, entry_offset + stub.packed_offset)?,
    )?;
    let packed_index = pe
        .sections
        .iter()
        .position(|section| contains_rva(section, packed_target))
        .ok_or("packed section not found")?;
    let packed = &pe.sections[packed_index];
    let raw_start = packed.raw_offset as usize;
    let raw_end = raw_start
        .checked_add(packed.raw_size as usize)
        .ok_or("packed section range overflow")?;
    let raw = bytes
        .get(raw_start..raw_end)
        .ok_or("packed section extends beyond input")?;
    if raw.len() < 6 {
        return Err("packed section header is truncated".into());
    }
    let output_size = usize::from(read_u16(raw, 0)?) << 12;
    let packed_size = read_u32(raw, 2)? as usize;
    if output_size == 0 || output_size > MAX_OUTPUT {
        return Err("declared output exceeds limit".into());
    }
    let compressed = raw
        .get(
            6..6usize
                .checked_add(packed_size)
                .ok_or("packed size overflow")?,
        )
        .ok_or("packed payload is truncated")?;
    let mut unpacked = match stub.compression {
        Compression::Lzmat => decompress_lzmat(compressed, output_size)?,
        Compression::Lzma => decompress_lzma(compressed, output_size)?,
    };
    unpacked.resize(output_size, 0);
    fix_relative_calls(&mut unpacked);

    let fix_target = relative_target(
        pe.entry_rva,
        stub.fix_offset + 4,
        read_i32(bytes, entry_offset + stub.fix_offset)?,
    )?;
    let fix_offset = fix_target
        .checked_sub(packed.virtual_address)
        .ok_or("fix stub precedes packed section")? as usize;
    let (import_offset, oep_offset) = match unpacked.get(fix_offset + 7).copied() {
        Some(0x8b) => (0xc1usize, 0xbdusize),
        Some(0x45) => (0x138, 0x134),
        Some(0x35) => (0x128, 0x124),
        _ => return Err("unsupported MPRESS fix stub".into()),
    };
    let oep_delta = read_i32(&unpacked, fix_offset + oep_offset)?;
    let oep_base = packed.virtual_address as i64 + fix_offset as i64 + import_offset as i64;
    let oep = u32::try_from(oep_base + i64::from(oep_delta)).map_err(|_| "OEP is out of range")?;

    let reloc_rva = read_u32(bytes, entry_offset + stub.reloc_offset)?;
    let reloc_size = read_u32(bytes, entry_offset + stub.reloc_size_offset)?;
    let output = rebuild_pe(
        bytes,
        &pe,
        packed_index,
        &unpacked,
        oep,
        reloc_rva,
        reloc_size,
    )?;
    let metadata = Metadata {
        packer: "mpress",
        version: stub.name,
        method: method_name(stub.compression),
        original_size: bytes.len(),
        output_size: output.len(),
        entry_point: format!("0x{oep:x}"),
        imports_rebuilt: false,
        runnable: false,
    };
    Ok((output, metadata))
}

fn parse_pe(bytes: &[u8]) -> Result<Pe, String> {
    if bytes.get(..2) != Some(b"MZ") {
        return Err("input is not a PE file".into());
    }
    let pe_offset = read_u32(bytes, 0x3c)? as usize;
    if bytes.get(pe_offset..pe_offset + 4) != Some(b"PE\0\0") {
        return Err("PE signature is missing".into());
    }
    let section_count = read_u16(bytes, pe_offset + 6)? as usize;
    if section_count == 0 || section_count > 96 {
        return Err("invalid PE section count".into());
    }
    let optional_size = read_u16(bytes, pe_offset + 20)? as usize;
    let optional_offset = pe_offset + 24;
    if read_u16(bytes, optional_offset)? != 0x10b {
        return Err("MPRESS WebAssembly target currently supports PE32 only".into());
    }
    let entry_rva = read_u32(bytes, optional_offset + 16)?;
    let section_alignment = read_u32(bytes, optional_offset + 32)?;
    let file_alignment = read_u32(bytes, optional_offset + 36)?;
    if section_alignment == 0 || file_alignment == 0 || !file_alignment.is_power_of_two() {
        return Err("invalid PE alignment".into());
    }
    let section_table = optional_offset
        .checked_add(optional_size)
        .ok_or("section table overflow")?;
    let mut sections = Vec::with_capacity(section_count);
    for index in 0..section_count {
        let header = section_table
            .checked_add(index * 40)
            .ok_or("section header overflow")?;
        bytes
            .get(header..header + 8)
            .ok_or("section header is truncated")?;
        sections.push(Section {
            header_offset: header,
            virtual_size: read_u32(bytes, header + 8)?,
            virtual_address: read_u32(bytes, header + 12)?,
            raw_size: read_u32(bytes, header + 16)?,
            raw_offset: read_u32(bytes, header + 20)?,
        });
    }
    Ok(Pe {
        optional_offset,
        entry_rva,
        file_alignment,
        section_alignment,
        sections,
    })
}

fn detect_stub<'a>(bytes: &[u8], pe: &Pe) -> Result<(usize, &'a Stub), String> {
    let entry_offset =
        rva_to_offset(pe, pe.entry_rva).ok_or("entry point is not backed by file data")?;
    let signature = read_u32(bytes, entry_offset + 8)?;
    let stub = STUBS
        .iter()
        .find(|stub| stub.signature == signature)
        .ok_or_else(|| {
            format!(
                "unsupported MPRESS unpacker stub 0x{signature:x} at file offset 0x{:x} for entry RVA 0x{:x}",
                entry_offset + 8,
                pe.entry_rva
            )
        })?;
    Ok((entry_offset, stub))
}

fn rebuild_pe(
    bytes: &[u8],
    pe: &Pe,
    packed_index: usize,
    unpacked: &[u8],
    oep: u32,
    reloc_rva: u32,
    reloc_size: u32,
) -> Result<Vec<u8>, String> {
    let packed = &pe.sections[packed_index];
    let old_size = packed.raw_size as usize;
    let new_size = align(unpacked.len(), pe.file_alignment as usize)?;
    let old_end = packed.raw_offset as usize + old_size;
    if old_end > bytes.len() {
        return Err("packed section extends beyond input".into());
    }
    let delta = isize::try_from(new_size).unwrap() - isize::try_from(old_size).unwrap();
    let final_size = if delta >= 0 {
        bytes.len().checked_add(delta as usize)
    } else {
        bytes.len().checked_sub((-delta) as usize)
    }
    .ok_or("output size overflow")?;
    if final_size > MAX_OUTPUT {
        return Err("rebuilt PE exceeds output limit".into());
    }
    let mut output = vec![0; final_size];
    let raw_start = packed.raw_offset as usize;
    output[..raw_start].copy_from_slice(&bytes[..raw_start]);
    output[raw_start..raw_start + unpacked.len()].copy_from_slice(unpacked);
    output[raw_start + new_size..].copy_from_slice(&bytes[old_end..]);

    write_u32(&mut output, pe.optional_offset + 16, oep)?;
    write_u32(&mut output, packed.header_offset + 8, unpacked.len() as u32)?;
    write_u32(&mut output, packed.header_offset + 16, new_size as u32)?;
    write_u32(&mut output, packed.header_offset + 36, 0xe000_0060)?;
    for section in pe.sections.iter().skip(packed_index + 1) {
        let moved = i64::from(section.raw_offset) + delta as i64;
        write_u32(
            &mut output,
            section.header_offset + 20,
            u32::try_from(moved).map_err(|_| "section offset is out of range")?,
        )?;
    }
    let size_of_image = pe
        .sections
        .iter()
        .enumerate()
        .map(|(index, section)| {
            let virtual_size = if index == packed_index {
                unpacked.len() as u32
            } else {
                section.virtual_size.max(section.raw_size)
            };
            u64::from(section.virtual_address) + u64::from(virtual_size)
        })
        .max()
        .unwrap_or(0);
    write_u32(
        &mut output,
        pe.optional_offset + 56,
        align(size_of_image as usize, pe.section_alignment as usize)? as u32,
    )?;
    if reloc_size > 0 {
        let reloc_directory = pe.optional_offset + 96 + 5 * 8;
        write_u32(&mut output, reloc_directory, reloc_rva)?;
        write_u32(&mut output, reloc_directory + 4, reloc_size)?;
    }
    Ok(output)
}

fn decompress_lzma(input: &[u8], output_size: usize) -> Result<Vec<u8>, String> {
    if input.len() < 7 {
        return Err("MPRESS LZMA payload is truncated".into());
    }
    let lp = input[0] & 0x0f;
    let pb = input[0] >> 4;
    let lc = input[1];
    if pb > 4 || lp > 4 || lc > 8 {
        return Err("invalid MPRESS LZMA properties".into());
    }
    let property = (pb * 5 + lp) * 9 + lc;
    let mut stream = Vec::with_capacity(input.len() + 11);
    stream.push(property);
    stream.extend_from_slice(&0x0080_0000u32.to_le_bytes());
    stream.extend_from_slice(&(output_size as u64).to_le_bytes());
    stream.extend_from_slice(&input[2..]);
    let mut output = Vec::with_capacity(output_size);
    lzma_rs::lzma_decompress(&mut Cursor::new(stream), &mut output)
        .map_err(|error| error.to_string())?;
    if output.len() > output_size {
        return Err("LZMA output exceeds declared size".into());
    }
    Ok(output)
}

fn decompress_lzmat(input: &[u8], capacity: usize) -> Result<Vec<u8>, String> {
    if input.is_empty() {
        return Err("MPRESS LZMAT payload is empty".into());
    }
    let mut output = vec![0; capacity];
    output[0] = input[0];
    let mut input_pos = 1usize;
    let mut output_pos = 1usize;
    let mut unaligned = false;
    while input_pos < input.len().saturating_sub(unaligned as usize) && output_pos < capacity {
        let mut control = get8(input, input_pos, unaligned)?;
        input_pos += 1;
        for _ in 0..8 {
            if input_pos >= input.len().saturating_sub(unaligned as usize) || output_pos >= capacity
            {
                break;
            }
            if control & 0x80 == 0 {
                output[output_pos] = get8(input, input_pos, unaligned)?;
                output_pos += 1;
                input_pos += 1;
                control <<= 1;
                continue;
            }
            let encoded = get16(input, input_pos, unaligned)? as u32;
            input_pos += 1;
            let distance = if output_pos < 0x881 {
                let mut value = encoded >> 1;
                if encoded & 1 != 0 {
                    value = (value & 0x7ff) + 0x81;
                    input_pos += unaligned as usize;
                    unaligned = !unaligned;
                } else {
                    value = (value & 0x7f) + 1;
                }
                value
            } else {
                let mut value = encoded >> 2;
                match encoded & 3 {
                    0 => value = (value & 0x3f) + 1,
                    1 => {
                        value = (value & 0x3ff) + 0x41;
                        input_pos += unaligned as usize;
                        unaligned = !unaligned;
                    }
                    2 => {
                        value += 0x441;
                        input_pos += 1;
                    }
                    _ => {
                        input_pos += 1;
                        value =
                            value + ((get4(input, input_pos, unaligned)? as u32) << 14) + 0x4441;
                    }
                }
                value
            };
            let mut length = get4(input, input_pos, unaligned)? as usize;
            if length != 0xf {
                length += 3;
            } else {
                length = get8(input, input_pos, unaligned)? as usize;
                input_pos += 1;
                if length != 0xff {
                    length += 0x12;
                } else {
                    length = get16(input, input_pos, unaligned)? as usize + 0x111;
                    input_pos += 2;
                    if length == 0x10110 {
                        return Err("unsupported LZMAT raw-copy marker".into());
                    }
                }
            }
            if distance == 0 || distance as usize > output_pos || output_pos + length > capacity {
                return Err("invalid LZMAT back-reference".into());
            }
            let mut source = output_pos - distance as usize;
            for _ in 0..length {
                output[output_pos] = output[source];
                output_pos += 1;
                source += 1;
            }
            control <<= 1;
        }
    }
    output.truncate(output_pos);
    Ok(output)
}

fn get4(input: &[u8], position: usize, unaligned: bool) -> Result<u8, String> {
    let value = *input.get(position).ok_or("LZMAT input is truncated")?;
    Ok(if unaligned { value >> 4 } else { value & 0xf })
}
fn get8(input: &[u8], position: usize, unaligned: bool) -> Result<u8, String> {
    let value = *input.get(position).ok_or("LZMAT input is truncated")?;
    if !unaligned {
        return Ok(value);
    }
    Ok((value >> 4)
        | input
            .get(position + 1)
            .copied()
            .ok_or("LZMAT input is truncated")?
            << 4)
}
fn get16(input: &[u8], position: usize, unaligned: bool) -> Result<u16, String> {
    let slice = input
        .get(position..position + 3)
        .ok_or("LZMAT input is truncated")?;
    let value = u32::from(slice[0]) | u32::from(slice[1]) << 8 | u32::from(slice[2]) << 16;
    Ok(if unaligned {
        (value >> 4) as u16
    } else {
        value as u16
    })
}

fn fix_relative_calls(bytes: &mut [u8]) {
    let maximum = bytes.len().saturating_sub(0x1000);
    let mut position = 0usize;
    while position + 5 <= maximum {
        let opcode = bytes[position];
        position += 1;
        if opcode != 0xe8 && opcode != 0xe9 {
            continue;
        }
        let move_offset = position;
        let Ok(mut offset) = read_i32(bytes, position) else {
            break;
        };
        position += 4;
        if offset >= 0 {
            if offset as usize >= maximum {
                continue;
            }
        } else {
            offset += move_offset as i32;
            if offset < 0 {
                continue;
            }
            offset += maximum as i32;
        }
        let fixed = offset - move_offset as i32;
        bytes[position - 4..position].copy_from_slice(&fixed.to_le_bytes());
    }
}

fn relative_target(entry: u32, offset: usize, relative: i32) -> Result<u32, String> {
    u32::try_from(i64::from(entry) + offset as i64 + i64::from(relative))
        .map_err(|_| "relative target is out of range".into())
}
fn rva_to_offset(pe: &Pe, rva: u32) -> Option<usize> {
    pe.sections
        .iter()
        .find(|section| contains_rva(section, rva))
        .and_then(|section| {
            let delta = rva.checked_sub(section.virtual_address)?;
            (delta < section.raw_size).then_some(section.raw_offset as usize + delta as usize)
        })
}
fn contains_rva(section: &Section, rva: u32) -> bool {
    const fn mapped_size(section: &Section) -> u32 {
        if section.virtual_size == 0 {
            section.raw_size
        } else {
            section.virtual_size
        }
    }
    rva >= section.virtual_address
        && rva < section.virtual_address.saturating_add(mapped_size(section))
}
fn align(value: usize, alignment: usize) -> Result<usize, String> {
    if alignment == 0 || !alignment.is_power_of_two() {
        return Err("invalid alignment".into());
    }
    value
        .checked_add(alignment - 1)
        .map(|value| value & !(alignment - 1))
        .ok_or("alignment overflow".into())
}
fn method_name(method: Compression) -> &'static str {
    match method {
        Compression::Lzma => "lzma",
        Compression::Lzmat => "lzmat",
    }
}
fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let value = bytes.get(offset..offset + 2).ok_or("read exceeds input")?;
    Ok(u16::from_le_bytes(value.try_into().unwrap()))
}
fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let value = bytes.get(offset..offset + 4).ok_or("read exceeds input")?;
    Ok(u32::from_le_bytes(value.try_into().unwrap()))
}
fn read_i32(bytes: &[u8], offset: usize) -> Result<i32, String> {
    let value = bytes.get(offset..offset + 4).ok_or("read exceeds input")?;
    Ok(i32::from_le_bytes(value.try_into().unwrap()))
}
fn write_u32(bytes: &mut [u8], offset: usize, value: u32) -> Result<(), String> {
    bytes
        .get_mut(offset..offset + 4)
        .ok_or("write exceeds output")?
        .copy_from_slice(&value.to_le_bytes());
    Ok(())
}
