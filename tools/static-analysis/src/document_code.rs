//! Offline source/IL extraction. No execution and no high-level .NET decompilation.
use serde_json::{json, Value};
use std::io::{Cursor, Read};

const INPUT: usize = 32 * 1024 * 1024;
const JSON: usize = 4 * 1024 * 1024 - 4096;
const ITEM: usize = 64 * 1024;
const COUNT: usize = 4096;

fn span(b: &[u8], p: usize, n: usize) -> Result<&[u8], String> {
    b.get(p..p.checked_add(n).ok_or("offset overflow")?)
        .ok_or_else(|| "out-of-bounds data".into())
}
fn u16le(b: &[u8], p: usize) -> Result<u16, String> {
    Ok(u16::from_le_bytes(span(b, p, 2)?.try_into().unwrap()))
}
fn u32le(b: &[u8], p: usize) -> Result<u32, String> {
    Ok(u32::from_le_bytes(span(b, p, 4)?.try_into().unwrap()))
}
fn number(o: &Value, key: &str, default: usize, max: usize) -> Result<usize, String> {
    match o.get(key).filter(|v| !v.is_null()) {
        None => Ok(default),
        Some(v) => v
            .as_u64()
            .filter(|n| *n <= max as u64)
            .map(|n| n as usize)
            .ok_or_else(|| format!("{key} must be an integer in 0..={max}")),
    }
}
fn limits(b: &[u8], o: &Value) -> Result<(usize, usize, usize), String> {
    if b.len() > INPUT {
        return Err("input exceeds 32 MiB".into());
    }
    let start = number(
        o,
        "index",
        number(o, "offset", 0, u32::MAX as usize)?,
        u32::MAX as usize,
    )?;
    let count = if o.get("index").is_some_and(|v| !v.is_null()) {
        1
    } else {
        number(o, "maxResults", 64, COUNT)?
    };
    let output = number(o, "maxOutputBytes", JSON, JSON + 4096)?.min(JSON);
    if count == 0 || output < 256 {
        return Err("maxResults must be positive and maxOutputBytes at least 256".into());
    }
    Ok((start, count, output))
}
fn finish(mut value: Value, key: &str, budget: usize) -> Result<Value, String> {
    while serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() > budget {
        if value[key]
            .as_array_mut()
            .ok_or("invalid result")?
            .pop()
            .is_none()
        {
            return Err("output budget too small".into());
        }
        value["truncated"] = json!(true);
    }
    let returned = value[key].as_array().unwrap().len();
    value["returned"] = json!(returned);
    // Reserve was included in the initial response; same-width or smaller count.
    Ok(value)
}

/// MS-OVBA 2.4.1: bounded expansion, including overlapping copy tokens.
fn decompress(b: &[u8], limit: usize) -> Result<(Vec<u8>, bool), String> {
    if b.first() != Some(&1) {
        return Err("invalid MS-OVBA compressed-container signature".into());
    }
    let mut p = 1;
    let mut out = Vec::new();
    while p < b.len() {
        let h = u16le(b, p)?;
        let end = p
            .checked_add((h as usize & 0xfff) + 3)
            .ok_or("chunk overflow")?;
        if h & 0x7000 != 0x3000 || end > b.len() {
            return Err("invalid MS-OVBA chunk".into());
        }
        p += 2;
        let base = out.len();
        if h & 0x8000 == 0 {
            if h != 0x3fff {
                return Err("invalid uncompressed chunk size".into());
            }
            let raw = span(b, p, 4096)?;
            let n = raw.len().min(limit.saturating_sub(out.len()));
            out.extend_from_slice(&raw[..n]);
            if n < raw.len() {
                return Ok((out, true));
            }
            p = end;
            continue;
        }
        while p < end {
            let flags = b[p];
            p += 1;
            for bit in 0..8 {
                if p >= end {
                    break;
                }
                if flags & (1 << bit) == 0 {
                    if out.len() - base >= 4096 {
                        return Err("chunk expansion exceeds 4096 bytes".into());
                    }
                    if out.len() == limit {
                        return Ok((out, true));
                    }
                    out.push(b[p]);
                    p += 1;
                    continue;
                }
                if p + 2 > end {
                    return Err("truncated copy token".into());
                }
                let token = u16le(b, p)? as usize;
                p += 2;
                let produced = out.len() - base;
                if produced == 0 {
                    return Err("copy token before literals".into());
                }
                let bits = (usize::BITS - (produced - 1).leading_zeros()).max(4) as usize;
                let mask = 0xffffusize >> bits;
                let length = (token & mask) + 3;
                let distance = (token >> (16 - bits)) + 1;
                if distance > produced || produced + length > 4096 {
                    return Err("invalid copy-token range".into());
                }
                for _ in 0..length {
                    if out.len() == limit {
                        return Ok((out, true));
                    }
                    out.push(out[out.len() - distance]);
                }
            }
        }
    }
    Ok((out, false))
}

struct Module {
    name: String,
    stream: String,
    offset: usize,
}
fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}
fn unicode(b: &[u8]) -> Result<String, String> {
    if b.len() % 2 != 0 {
        return Err("odd UTF-16 length".into());
    }
    String::from_utf16(
        &b.chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect::<Vec<_>>(),
    )
    .map_err(|_| "invalid UTF-16 module name".into())
}
fn module_records(b: &[u8], mut p: usize) -> Result<Vec<Module>, String> {
    let count = u16le(b, p + 6)? as usize;
    if count > COUNT {
        return Err("VBA module count exceeds 4096".into());
    }
    p += 8;
    if span(b, p, 6)? != [0x13, 0, 2, 0, 0, 0] {
        return Err("missing PROJECTCOOKIE".into());
    }
    p += 8;
    let mut modules = Vec::new();
    for _ in 0..count {
        let mut name = None;
        let mut stream = None;
        let mut offset = None;
        let mut terminated = false;
        for _ in 0..32 {
            let id = u16le(b, p)?;
            let n = u32le(b, p + 2)? as usize;
            if n > 4096 {
                return Err("oversized module directory record".into());
            }
            p += 6;
            let data = span(b, p, n)?;
            p += n;
            match id {
                0x19 => {
                    if name.is_some() {
                        return Err("duplicate module name".into());
                    }
                    name = Some(text(data));
                }
                0x47 => name = Some(unicode(data)?),
                0x1a => stream = Some(text(data)),
                0x32 => stream = Some(unicode(data)?),
                0x31 if n == 4 => {
                    if offset.is_some() {
                        return Err("duplicate MODULEOFFSET".into());
                    }
                    offset = Some(u32le(data, 0)? as usize);
                }
                0x2b if n == 0 => {
                    terminated = true;
                    break;
                }
                0x1c | 0x48 | 0x1e | 0x2c | 0x21 | 0x22 | 0x25 | 0x28 => (),
                _ => return Err(format!("unsupported or malformed module record {id:#x}")),
            }
        }
        if !terminated {
            return Err("unterminated module record".into());
        }
        let stream = stream.ok_or("missing module stream name")?;
        if stream.is_empty() || stream.contains(['/', '\\', '\0']) {
            return Err("invalid module stream name".into());
        }
        modules.push(Module {
            name: name.ok_or("missing module name")?,
            stream,
            offset: offset.ok_or("missing MODULEOFFSET")?,
        });
    }
    if span(b, p, 6)? != [0x10, 0, 0, 0, 0, 0] {
        return Err("missing PROJECTTERMINATOR".into());
    }
    Ok(modules)
}

pub fn vba_extract(bytes: &[u8], options: &Value) -> Result<Value, String> {
    let (start, count, budget) = limits(bytes, options)?;
    let mut embedded = Vec::new();
    let ole = if bytes.starts_with(b"PK") {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
        if zip.len() > COUNT {
            return Err("ZIP entry count exceeds 4096".into());
        }
        let mut chosen = None;
        for i in 0..zip.len() {
            let entry = zip.by_index(i).map_err(|e| e.to_string())?;
            if entry
                .name()
                .rsplit('/')
                .next()
                .is_some_and(|n| n.eq_ignore_ascii_case("vbaProject.bin"))
            {
                if chosen.replace(i).is_some() {
                    return Err("multiple vbaProject.bin entries are ambiguous".into());
                }
            }
        }
        let entry = zip
            .by_index(chosen.ok_or("OOXML has no vbaProject.bin")?)
            .map_err(|e| e.to_string())?;
        if entry.size() > INPUT as u64 {
            return Err("vbaProject.bin expansion exceeds 32 MiB".into());
        }
        entry
            .take(INPUT as u64 + 1)
            .read_to_end(&mut embedded)
            .map_err(|e| e.to_string())?;
        if embedded.len() > INPUT {
            return Err("vbaProject.bin expansion exceeds 32 MiB".into());
        }
        embedded.as_slice()
    } else {
        bytes
    };
    let mut cfb = cfb::CompoundFile::open(Cursor::new(ole)).map_err(|e| e.to_string())?;
    if cfb.walk().take(COUNT + 1).count() > COUNT {
        return Err("CFB entry count exceeds 4096".into());
    }
    let dirs: Vec<_> = cfb
        .walk()
        .filter(|e| {
            e.is_stream()
                && e.name().eq_ignore_ascii_case("dir")
                && e.path()
                    .parent()
                    .and_then(|p| p.file_name())
                    .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("VBA"))
        })
        .map(|e| e.path().to_path_buf())
        .collect();
    if dirs.len() != 1 {
        return Err("expected one VBA/dir stream within bounded CFB directory".into());
    }
    let mut compressed = Vec::new();
    cfb.open_stream(&dirs[0])
        .map_err(|e| e.to_string())?
        .take(INPUT as u64 + 1)
        .read_to_end(&mut compressed)
        .map_err(|e| e.to_string())?;
    if compressed.len() > INPUT {
        return Err("VBA directory stream too large".into());
    }
    let (dir, truncated) = decompress(&compressed, 1024 * 1024)?;
    if truncated {
        return Err("VBA directory expansion exceeds 1 MiB".into());
    }
    // Locate PROJECTMODULES + PROJECTCOOKIE, then validate the complete module
    // record sequence. Reference records preceding it have variable layouts.
    let candidates: Vec<_> = dir
        .windows(6)
        .enumerate()
        .filter(|(_, w)| *w == [15, 0, 2, 0, 0, 0])
        .take(65)
        .map(|(p, _)| p)
        .collect();
    if candidates.len() > 64 {
        return Err("too many module-directory candidates".into());
    }
    let mut parsed = None;
    for p in candidates {
        if let Ok(modules) = module_records(&dir, p) {
            if parsed.replace(modules).is_some() {
                return Err("ambiguous module directory".into());
            }
        }
    }
    let modules =
        parsed.ok_or("no valid VBA module directory (unsupported or malformed project)")?;
    if start > modules.len()
        || (options.get("index").is_some_and(|v| !v.is_null()) && start == modules.len())
    {
        return Err("module index out of range".into());
    }
    let mut results = Vec::new();
    let mut used = 512;
    let mut read_bytes = 0usize;
    let mut partial = false;
    for (i, module) in modules.iter().enumerate().skip(start).take(count) {
        let path = dirs[0]
            .parent()
            .ok_or("invalid directory path")?
            .join(&module.stream);
        let mut raw = Vec::new();
        cfb.open_stream(path)
            .map_err(|e| e.to_string())?
            .take(INPUT as u64 + 1)
            .read_to_end(&mut raw)
            .map_err(|e| e.to_string())?;
        if raw.len() > INPUT {
            return Err("module stream exceeds 32 MiB".into());
        }
        read_bytes += raw.len();
        if read_bytes > INPUT * 2 {
            return Err("aggregate module reads exceed 64 MiB; select fewer modules".into());
        }
        let (source, cut) = decompress(
            raw.get(module.offset..)
                .ok_or("MODULEOFFSET out of bounds")?,
            ITEM,
        )?;
        let lossy = std::str::from_utf8(&source).is_err();
        let row = json!({"index":i,"name":module.name,"stream":module.stream,"sourceOffset":module.offset,"source":text(&source),"sourceHex":hex::encode(&source),"sourceBytes":source.len(),"truncated":cut,"textEncoding":"UTF-8 preview; sourceHex preserves original project-codepage bytes","encodingLossy":lossy});
        used += serde_json::to_vec(&row).map_err(|e| e.to_string())?.len() + 1;
        if used > budget {
            break;
        }
        partial |= cut;
        results.push(row);
    }
    finish(
        json!({"format":"VBA","modules":results,"totalModules":modules.len(),"offset":start,"returned":results.len(),"truncated":partial || start + results.len() < modules.len(),"limitations":["Source extraction only; compiled VBA p-code is not inspected (VBA stomping may differ).","Project reference records are not validated; module records and source offsets are validated."]}),
        "modules",
        budget,
    )
}

fn heap_string(b: &[u8], p: usize) -> Result<String, String> {
    let tail = b.get(p..).ok_or("string heap index out of bounds")?;
    let end = tail
        .iter()
        .take(ITEM + 1)
        .position(|c| *c == 0)
        .ok_or("unterminated or oversized metadata name")?;
    std::str::from_utf8(&tail[..end])
        .map(str::to_owned)
        .map_err(|_| "invalid metadata UTF-8".into())
}

pub fn dotnet_methods(bytes: &[u8], options: &Value) -> Result<Value, String> {
    let (start, count, budget) = limits(bytes, options)?;
    let pe = goblin::pe::PE::parse(bytes).map_err(|e| e.to_string())?;
    let optional = pe
        .header
        .optional_header
        .as_ref()
        .ok_or("missing PE optional header")?;
    let clr = optional
        .data_directories
        .get_clr_runtime_header()
        .ok_or("PE has no CLR header")?;
    let map = |rva: u32, size: usize| -> Result<&[u8], String> {
        if rva < optional.windows_fields.size_of_headers {
            if rva as u64 + size as u64 > optional.windows_fields.size_of_headers as u64 {
                return Err("RVA crosses headers".into());
            }
            return span(bytes, rva as usize, size);
        }
        for section in &pe.sections {
            if let Some(delta) = rva.checked_sub(section.virtual_address) {
                if delta as u64 + size as u64 <= section.size_of_raw_data as u64 {
                    let p = (section.pointer_to_raw_data as usize)
                        .checked_add(delta as usize)
                        .ok_or("RVA overflow")?;
                    return span(bytes, p, size);
                }
            }
        }
        Err("RVA not backed by section file data".into())
    };
    if clr.size < 72 {
        return Err("short CLR header".into());
    }
    let cli = map(clr.virtual_address, 72)?;
    if u32le(cli, 0)? < 72 {
        return Err("invalid CLR header size".into());
    }
    let metadata = map(u32le(cli, 8)?, u32le(cli, 12)? as usize)?;
    if span(metadata, 0, 4)? != b"BSJB" {
        return Err("invalid CLR metadata signature".into());
    }
    let version_len = u32le(metadata, 12)? as usize;
    let mut p = 16usize
        .checked_add(version_len)
        .ok_or("metadata overflow")?;
    p = p.checked_add(3).ok_or("metadata overflow")? & !3;
    let streams = u16le(metadata, p + 2)? as usize;
    p += 4;
    if streams > 64 {
        return Err("metadata stream count exceeds 64".into());
    }
    let mut tables = None;
    let mut strings = None;
    for _ in 0..streams {
        let offset = u32le(metadata, p)? as usize;
        let size = u32le(metadata, p + 4)? as usize;
        p += 8;
        let tail = metadata.get(p..).ok_or("stream name out of bounds")?;
        let n = tail
            .iter()
            .take(32)
            .position(|c| *c == 0)
            .ok_or("invalid metadata stream name")?;
        let name = &tail[..n];
        p += (n + 1 + 3) & !3;
        let data = span(metadata, offset, size)?;
        if name == b"#~" || name == b"#-" {
            if tables.replace(data).is_some() {
                return Err("duplicate metadata tables".into());
            }
        }
        if name == b"#Strings" && strings.replace(data).is_some() {
            return Err("duplicate string heap".into());
        }
    }
    let tables = tables.ok_or("missing metadata tables")?;
    let strings = strings.ok_or("missing #Strings heap")?;
    span(tables, 0, 24)?;
    let heaps = tables[6];
    let valid = u64::from_le_bytes(span(tables, 8, 8)?.try_into().unwrap());
    let mut rows = [0usize; 64];
    p = 24;
    for (i, row) in rows.iter_mut().enumerate() {
        if valid & (1u64 << i) != 0 {
            *row = u32le(tables, p)? as usize;
            p += 4;
        }
    }
    let index = |table: usize| if rows[table] < 65536 { 2usize } else { 4 };
    let coded = |set: &[usize], bits: usize| {
        if set.iter().all(|i| rows[*i] < (1 << (16 - bits))) {
            2usize
        } else {
            4
        }
    };
    let string = if heaps & 1 == 0 { 2 } else { 4 };
    let guid = if heaps & 2 == 0 { 2 } else { 4 };
    let blob = if heaps & 4 == 0 { 2 } else { 4 };
    // ECMA-335 II.22 tables preceding MethodDef, including #- pointer tables.
    let sizes = [
        2 + string + guid * 3,
        coded(&[0, 26, 35, 1], 2) + string * 2,
        4 + string * 2
            + coded(&[2, 1, 27], 2)
            + index(if rows[3] > 0 { 3 } else { 4 })
            + index(if rows[5] > 0 { 5 } else { 6 }),
        index(4),
        2 + string + blob,
        index(6),
    ];
    for i in 0..6 {
        let n = rows[i]
            .checked_mul(sizes[i])
            .ok_or("metadata table overflow")?;
        span(tables, p, n)?;
        p = p.checked_add(n).ok_or("metadata table overflow")?;
    }
    let row_size = 8 + string + blob + index(if rows[7] > 0 { 7 } else { 8 });
    span(
        tables,
        p,
        rows[6]
            .checked_mul(row_size)
            .ok_or("MethodDef size overflow")?,
    )?;
    if start > rows[6] || (options.get("index").is_some_and(|v| !v.is_null()) && start == rows[6]) {
        return Err("method index out of range".into());
    }
    let mut methods = Vec::new();
    let mut used = 256;
    let mut partial = false;
    for i in start..rows[6].min(start.saturating_add(count)) {
        let row = p + i * row_size;
        let rva = u32le(tables, row)?;
        let implementation = u16le(tables, row + 4)?;
        let name_index = if string == 2 {
            u16le(tables, row + 8)? as usize
        } else {
            u32le(tables, row + 8)? as usize
        };
        let mut method = json!({"index":i,"token":0x06000000u32 | (i as u32 + 1),"rva":rva,"name":heap_string(strings,name_index)?,"implFlags":implementation,"flags":u16le(tables,row+6)?,"truncated":false});
        if rva == 0 {
            method["bodyKind"] = json!("absent");
        } else if implementation & 3 != 0 || implementation & 4 != 0 {
            method["bodyKind"] = json!("non-IL; not decoded");
        } else {
            let first = map(rva, 1)?[0];
            let (header_size, code_size, extra) = match first & 3 {
                2 => (1usize, (first >> 2) as usize, false),
                3 => {
                    let h = map(rva, 12)?;
                    let flags = u16le(h, 0)?;
                    let size = ((flags >> 12) as usize) * 4;
                    if size < 12 {
                        return Err("invalid fat IL header".into());
                    }
                    map(rva, size)?;
                    method["maxStack"] = json!(u16le(h, 2)?);
                    method["localSignatureToken"] = json!(u32le(h, 8)?);
                    (size, u32le(h, 4)? as usize, flags & 8 != 0)
                }
                _ => return Err("invalid method body header".into()),
            };
            let body_rva = rva
                .checked_add(header_size as u32)
                .ok_or("method RVA overflow")?;
            let code = map(body_rva, code_size)?;
            let cut = code_size > ITEM;
            partial |= cut;
            method["bodyKind"] = json!("raw IL");
            method["codeSize"] = json!(code_size);
            method["ilHex"] = json!(hex::encode(&code[..code_size.min(ITEM)]));
            method["truncated"] = json!(cut);
            method["extraSectionsPresent"] = json!(extra);
            method["extraSectionsDecoded"] = json!(false);
        }
        used += serde_json::to_vec(&method)
            .map_err(|e| e.to_string())?
            .len()
            + 1;
        if used > budget {
            break;
        }
        methods.push(method);
    }
    finish(
        json!({"format":"CLI MethodDef","inspection":"metadata and raw IL only; not high-level decompilation; exception sections not decoded","totalMethods":rows[6],"offset":start,"returned":methods.len(),"truncated":partial || start + methods.len() < rows[6],"methods":methods}),
        "methods",
        budget,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn literals(data: &[u8]) -> Vec<u8> {
        let mut out = vec![1];
        for chunk in data.chunks(3000) {
            let mut body = Vec::new();
            for group in chunk.chunks(8) {
                body.push(0);
                body.extend_from_slice(group);
            }
            out.extend_from_slice(&(0xb000 | (body.len() as u16 - 1)).to_le_bytes());
            out.extend(body);
        }
        out
    }
    fn record(b: &mut Vec<u8>, id: u16, data: &[u8]) {
        b.extend(id.to_le_bytes());
        b.extend((data.len() as u32).to_le_bytes());
        b.extend(data);
    }
    fn ole(source: &[u8], offset: u32) -> Vec<u8> {
        let mut dir = Vec::new();
        record(&mut dir, 1, &1u32.to_le_bytes());
        record(&mut dir, 2, &0x409u32.to_le_bytes());
        record(&mut dir, 0x14, &0x409u32.to_le_bytes());
        record(&mut dir, 3, &1252u16.to_le_bytes());
        record(&mut dir, 4, b"Project");
        record(&mut dir, 0xf, &1u16.to_le_bytes());
        record(&mut dir, 0x13, &0u16.to_le_bytes());
        record(&mut dir, 0x19, b"Module1");
        record(&mut dir, 0x1a, b"Module1");
        record(
            &mut dir,
            0x32,
            &"Module1"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        record(&mut dir, 0x31, &offset.to_le_bytes());
        record(&mut dir, 0x1e, &0u32.to_le_bytes());
        record(&mut dir, 0x2c, &0u16.to_le_bytes());
        record(&mut dir, 0x21, &[]);
        record(&mut dir, 0x2b, &[]);
        record(&mut dir, 0x10, &[]);
        let mut c = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
        c.create_storage("/VBA").unwrap();
        c.create_stream("/VBA/dir")
            .unwrap()
            .write_all(&literals(&dir))
            .unwrap();
        c.create_stream("/VBA/Module1")
            .unwrap()
            .write_all(&literals(source))
            .unwrap();
        c.into_inner().into_inner()
    }
    #[test]
    fn actual_ole_and_ooxml_source() {
        let source = b"Attribute VB_Name = \"Module1\"\r\nSub Hello()\r\nEnd Sub\r\n";
        let b = ole(source, 0);
        let result = vba_extract(&b, &json!({})).unwrap();
        assert_eq!(result["modules"][0]["source"], text(source));
        assert_eq!(result["modules"][0]["sourceHex"], hex::encode(source));
        assert_eq!(result["truncated"], false);
        let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
        z.start_file(
            "word/vbaProject.bin",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        z.write_all(&b).unwrap();
        let zipped = z.finish().unwrap().into_inner();
        assert_eq!(
            vba_extract(&zipped, &json!({"index":0})).unwrap()["modules"][0]["source"],
            text(source)
        );
        assert!(vba_extract(&b, &json!({"index":1})).is_err());
        assert!(vba_extract(&ole(source, u32::MAX), &json!({})).is_err());
        assert!(vba_extract(b"garbage", &json!({})).is_err());
    }
    #[test]
    fn compressed_copy_bombs_and_truncation() {
        // One literal followed by an overlapping copy of 4095 bytes.
        let chunk = [3, 0xb0, 2, b'A', 0xfc, 0x0f];
        let mut bomb = vec![1];
        for _ in 0..300 {
            bomb.extend(chunk);
        }
        let (decoded, cut) = decompress(&bomb, ITEM).unwrap();
        assert_eq!(decoded, vec![b'A'; ITEM]);
        assert!(cut);
        assert!(decompress(&[1, 2, 0xb0, 1, 0, 0], ITEM).is_err());
        assert!(decompress(&[1, 0xff, 0xbf, 0], ITEM).is_err());
        let b = ole(&vec![b'A'; ITEM + 1], 0);
        let result = vba_extract(&b, &json!({})).unwrap();
        assert_eq!(result["modules"][0]["sourceBytes"], ITEM);
        assert_eq!(result["modules"][0]["truncated"], true);
    }
    fn put16(b: &mut [u8], p: usize, n: u16) {
        b[p..p + 2].copy_from_slice(&n.to_le_bytes());
    }
    fn put32(b: &mut [u8], p: usize, n: u32) {
        b[p..p + 4].copy_from_slice(&n.to_le_bytes());
    }
    fn managed_pe() -> Vec<u8> {
        let mut b = vec![0; 2048];
        b[..2].copy_from_slice(b"MZ");
        put32(&mut b, 0x3c, 0x80);
        b[0x80..0x84].copy_from_slice(b"PE\0\0");
        put16(&mut b, 0x84, 0x14c);
        put16(&mut b, 0x86, 1);
        put16(&mut b, 0x94, 224);
        put16(&mut b, 0x96, 0x102);
        let o = 0x98;
        put16(&mut b, o, 0x10b);
        put32(&mut b, o + 28, 0x400000);
        put32(&mut b, o + 32, 0x2000);
        put32(&mut b, o + 36, 0x200);
        put32(&mut b, o + 56, 0x4000);
        put32(&mut b, o + 60, 0x200);
        put32(&mut b, o + 92, 16);
        put32(&mut b, o + 96 + 14 * 8, 0x2000);
        put32(&mut b, o + 100 + 14 * 8, 72);
        let s = o + 224;
        b[s..s + 5].copy_from_slice(b".text");
        put32(&mut b, s + 8, 0x600);
        put32(&mut b, s + 12, 0x2000);
        put32(&mut b, s + 16, 0x600);
        put32(&mut b, s + 20, 0x200);
        put32(&mut b, s + 36, 0x60000020);
        put32(&mut b, 0x200, 72);
        put16(&mut b, 0x204, 2);
        put16(&mut b, 0x206, 5);
        put32(&mut b, 0x208, 0x2100);
        put32(&mut b, 0x20c, 0x100);
        put32(&mut b, 0x210, 1);
        let m = 0x300;
        b[m..m + 4].copy_from_slice(b"BSJB");
        put16(&mut b, m + 4, 1);
        put16(&mut b, m + 6, 1);
        put32(&mut b, m + 12, 12);
        b[m + 16..m + 27].copy_from_slice(b"v4.0.30319\0");
        put16(&mut b, m + 30, 2);
        put32(&mut b, m + 32, 0x60);
        put32(&mut b, m + 36, 42);
        b[m + 40..m + 43].copy_from_slice(b"#~\0");
        put32(&mut b, m + 44, 0xc0);
        put32(&mut b, m + 48, 6);
        b[m + 52..m + 61].copy_from_slice(b"#Strings\0");
        let t = m + 0x60;
        b[t + 4] = 2;
        b[t + 7] = 1;
        b[t + 8] = 0x40;
        put32(&mut b, t + 24, 1);
        put32(&mut b, t + 28, 0x2300);
        put16(&mut b, t + 34, 0x16);
        put16(&mut b, t + 36, 1);
        put16(&mut b, t + 40, 1);
        b[m + 0xc0..m + 0xc6].copy_from_slice(b"\0Main\0");
        b[0x500] = 6;
        b[0x501] = 0x2a; // tiny header, ret
        b
    }
    #[test]
    fn methoddef_and_actual_il() {
        let mut b = managed_pe();
        let result = dotnet_methods(&b, &json!({})).unwrap();
        assert_eq!(result["methods"][0]["name"], "Main");
        assert_eq!(result["methods"][0]["token"], 0x06000001u32);
        assert_eq!(result["methods"][0]["ilHex"], "2a");
        assert_eq!(result["truncated"], false);
        assert!(dotnet_methods(&b, &json!({"index":1})).is_err());
        put32(&mut b, 0x360 + 28, 0xfffffff0);
        assert!(dotnet_methods(&b, &json!({})).is_err());
        assert!(dotnet_methods(b"MZ", &json!({})).is_err());
    }
    #[test]
    fn fat_il_and_output_budgets() {
        let mut b = managed_pe();
        put16(&mut b, 0x500, 0x3013);
        put16(&mut b, 0x502, 8);
        put32(&mut b, 0x504, 2);
        put32(&mut b, 0x508, 0);
        b[0x50c] = 0x16;
        b[0x50d] = 0x2a;
        let result = dotnet_methods(&b, &json!({})).unwrap();
        assert_eq!(result["methods"][0]["ilHex"], "162a");
        assert_eq!(result["methods"][0]["maxStack"], 8);
        let small = dotnet_methods(&b, &json!({"maxOutputBytes":256})).unwrap();
        assert!(serde_json::to_vec(&small).unwrap().len() <= 256);
        assert_eq!(small["truncated"], true);
        put32(&mut b, 0x504, u32::MAX);
        assert!(dotnet_methods(&b, &json!({})).is_err());
    }
    #[test]
    fn zip_expansion_bomb_is_rejected_before_reading() {
        let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
        z.start_file(
            "xl/vbaProject.bin",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        let block = [0u8; 8192];
        for _ in 0..(INPUT / block.len() + 1) {
            z.write_all(&block).unwrap();
        }
        let b = z.finish().unwrap().into_inner();
        assert!(b.len() < INPUT);
        assert!(vba_extract(&b, &json!({}))
            .unwrap_err()
            .contains("expansion"));
    }
}
