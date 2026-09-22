//! Bounded linear decoding, not function discovery or execution.
use iced_x86::{Decoder, DecoderOptions, FlowControl, Formatter, IntelFormatter, OpKind};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use yaxpeax_arch::U8Reader;

const MAX_BYTES: usize = 4096;
const MAX_INSTRUCTIONS: usize = 256;

struct Range<'a> {
    bytes: &'a [u8],
    offset: usize,
    address: u64,
    requested: usize,
    bitness: u32,
    arm: bool,
}

struct Decoded {
    address: u64,
    length: usize,
    record: Value,
    kind: &'static str,
    target: Option<u64>,
    unresolved: Option<&'static str>,
    fallthrough: bool,
}

pub fn disassemble_arm64(bytes: &[u8], options: &Value) -> Result<Value, String> {
    let range = range(bytes, options, true)?;
    let instructions = decode(&range)?;
    Ok(report(&range, &instructions))
}

pub fn function_flow(bytes: &[u8], options: &Value) -> Result<Value, String> {
    let range = range(bytes, options, false)?;
    let instructions = decode(&range)?;
    let mut result = report(&range, &instructions);
    let addresses: BTreeSet<_> = instructions.iter().map(|item| item.address).collect();
    let mut leaders = BTreeSet::new();
    if let Some(first) = instructions.first() {
        leaders.insert(first.address);
    }
    let mut edges = Vec::new();
    for (index, item) in instructions.iter().enumerate() {
        if item.kind == "next" {
            continue;
        }
        if let Some(target) = item.target {
            if addresses.contains(&target) {
                leaders.insert(target);
            }
        }
        // Calls terminate a block, but their continuation is only a potential return path.
        if let Some(next) = instructions.get(index + 1) {
            leaders.insert(next.address);
        }
        edges.push(json!({
            "source": format!("0x{:x}", item.address), "kind": item.kind,
            "target": item.target.map(|value| format!("0x{value:x}")),
            "targetInDecodedRange": item.target.map(|value| addresses.contains(&value)).unwrap_or(false),
            "unresolved": item.unresolved,
        }));
    }
    let mut blocks = Vec::new();
    let mut start = 0;
    while start < instructions.len() {
        let end = (start + 1..instructions.len())
            .find(|index| leaders.contains(&instructions[*index].address))
            .unwrap_or(instructions.len());
        let last = &instructions[end - 1];
        let next_address = last
            .address
            .checked_add(last.length as u64)
            .ok_or("address overflow")?;
        let mut successors = Vec::new();
        if let Some(target) = last.target {
            if last.kind != "call" {
                successors.push(json!({"kind": last.kind, "address": format!("0x{target:x}"), "inDecodedRange": addresses.contains(&target)}));
            }
        }
        if last.fallthrough {
            successors.push(json!({"kind": if last.kind == "call" || last.kind == "indirect_call" { "call_continuation" } else { "fallthrough" }, "address": format!("0x{next_address:x}"), "inDecodedRange": addresses.contains(&next_address)}));
        }
        blocks.push(json!({
            "address": format!("0x{:x}", instructions[start].address),
            "endAddressExclusive": format!("0x{next_address:x}"),
            "instructionStart": start, "instructionCount": end - start,
            "successors": successors, "unresolved": last.unresolved,
        }));
        start = end;
    }
    result["edges"] = json!(edges);
    result["blocks"] = json!(blocks);
    result["scope"] = json!("linear decoding of the selected byte range only; no function discovery, global cross-references, reachability proof, or indirect-target resolution");
    result["flowCoverage"] = json!("direct branches and calls, indirect transfers and returns; exceptional/system transfers are unresolved");
    Ok(result)
}

fn integer(options: &Value, name: &str, default: u64) -> Result<u64, String> {
    match options.get(name) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value
            .as_u64()
            .ok_or_else(|| format!("{name} must be an unsigned integer")),
    }
}

fn range<'a>(bytes: &'a [u8], options: &Value, force_arm: bool) -> Result<Range<'a>, String> {
    let architecture = match options.get("architecture") {
        None | Some(Value::Null) => {
            if force_arm {
                "arm64"
            } else {
                "x86"
            }
        }
        Some(Value::String(value)) => value.as_str(),
        _ => return Err("architecture must be a string".into()),
    };
    let arm = matches!(architecture, "arm64" | "aarch64");
    if !arm && !matches!(architecture, "x86" | "x86_64" | "x64") || force_arm && !arm {
        return Err("supported architectures are x86, x86_64, and arm64".into());
    }
    let bitness = integer(options, "bitness", 64)?;
    if !matches!(bitness, 16 | 32 | 64)
        || arm && bitness != 64
        || matches!(architecture, "x86_64" | "x64") && bitness != 64
    {
        return Err("invalid bitness for architecture".into());
    }
    let offset = usize::try_from(integer(options, "offset", 0)?).map_err(|_| "offset overflow")?;
    if offset > bytes.len() {
        return Err("offset is outside the input".into());
    }
    let requested = usize::try_from(integer(
        options,
        "length",
        (bytes.len() - offset).min(64) as u64,
    )?)
    .map_err(|_| "length overflow")?;
    if requested == 0 {
        return Err("selected range must not be empty".into());
    }
    let end = offset.checked_add(requested).ok_or("file range overflow")?;
    if end > bytes.len() {
        return Err("selected range exceeds input bounds".into());
    }
    let address = match options.get("address") {
        Some(Value::String(value)) => {
            let value = value
                .strip_prefix("0x")
                .or_else(|| value.strip_prefix("0X"))
                .ok_or("address string must be hexadecimal with a 0x prefix")?;
            u64::from_str_radix(value, 16).map_err(|_| "invalid hexadecimal address")?
        }
        _ => integer(options, "address", offset as u64)?,
    };
    address
        .checked_add(requested as u64)
        .ok_or("virtual address range overflow")?;
    if arm && address % 4 != 0 {
        return Err("ARM64 virtual address must be four-byte aligned".into());
    }
    if bitness < 64 && address + requested as u64 > (1u64 << bitness) {
        return Err("virtual address range exceeds bitness".into());
    }
    Ok(Range {
        bytes: &bytes[offset..offset + requested.min(MAX_BYTES)],
        offset,
        address,
        requested,
        bitness: bitness as u32,
        arm,
    })
}

fn decode(range: &Range<'_>) -> Result<Vec<Decoded>, String> {
    let mut output = Vec::new();
    let mut position = 0;
    let mut formatter = IntelFormatter::new();
    let mut x86 = Decoder::with_ip(
        range.bitness,
        range.bytes,
        range.address,
        DecoderOptions::NONE,
    );
    while position < range.bytes.len() && output.len() < MAX_INSTRUCTIONS {
        let address = range
            .address
            .checked_add(position as u64)
            .ok_or("address overflow")?;
        let mut item = Decoded {
            address,
            length: 0,
            record: Value::Null,
            kind: "next",
            target: None,
            unresolved: None,
            fallthrough: true,
        };
        let (text, invalid) = if range.arm {
            item.length = (range.bytes.len() - position).min(4);
            let mut reader = U8Reader::new(&range.bytes[position..position + item.length]);
            match yaxpeax_arch::Decoder::decode(
                &yaxpeax_arm::armv8::a64::InstDecoder::default(),
                &mut reader,
            ) {
                Ok(instruction) => {
                    let text = instruction.to_string();
                    arm_flow(&instruction, &mut item);
                    (text, false)
                }
                Err(error) => (format!("<invalid: {error}>"), true),
            }
        } else {
            let instruction = x86.decode();
            item.length = instruction.len();
            let mut text = String::new();
            formatter.format(&instruction, &mut text);
            match instruction.flow_control() {
                FlowControl::Next => {}
                FlowControl::UnconditionalBranch => {
                    item.kind = "branch";
                    item.fallthrough = false;
                }
                FlowControl::ConditionalBranch => item.kind = "conditional_branch",
                FlowControl::Call => item.kind = "call",
                FlowControl::IndirectBranch => {
                    item.kind = "indirect_branch";
                    item.fallthrough = false;
                    item.unresolved = Some("indirect target");
                }
                FlowControl::IndirectCall => {
                    item.kind = "indirect_call";
                    item.unresolved = Some("indirect target");
                }
                FlowControl::Return => {
                    item.kind = "return";
                    item.fallthrough = false;
                    item.unresolved = Some("return target");
                }
                _ => {
                    item.kind = "system_transfer";
                    item.fallthrough = false;
                    item.unresolved = Some("exceptional/system control flow");
                }
            }
            if matches!(item.kind, "branch" | "conditional_branch" | "call") {
                if matches!(
                    instruction.op0_kind(),
                    OpKind::NearBranch16 | OpKind::NearBranch32 | OpKind::NearBranch64
                ) {
                    item.target = Some(instruction.near_branch_target());
                } else {
                    item.unresolved = Some("segmented/far target");
                }
            }
            (
                if instruction.is_invalid() {
                    "<invalid instruction>".into()
                } else {
                    text
                },
                instruction.is_invalid(),
            )
        };
        if invalid {
            item.kind = "invalid";
            item.fallthrough = false;
            item.unresolved = Some("invalid or incomplete instruction; decoding stopped");
        }
        if item.length == 0 {
            return Err("decoder made no progress".into());
        }
        let end = position
            .checked_add(item.length)
            .ok_or("instruction range overflow")?;
        let raw = range
            .bytes
            .get(position..end)
            .ok_or("decoder exceeded selected range")?;
        item.record = json!({"address": format!("0x{address:x}"), "bytes": hex::encode(raw), "text": text, "invalid": invalid});
        output.push(item);
        position = end;
        if invalid {
            break;
        }
    }
    Ok(output)
}

fn arm_flow(instruction: &yaxpeax_arm::armv8::a64::Instruction, item: &mut Decoded) {
    use yaxpeax_arm::armv8::a64::{Opcode, Operand};
    match instruction.opcode {
        Opcode::B => {
            item.kind = "branch";
            item.fallthrough = false;
        }
        Opcode::BL => item.kind = "call",
        Opcode::Bcc(_)
        | Opcode::BCcc(_)
        | Opcode::CBZ
        | Opcode::CBNZ
        | Opcode::TBZ
        | Opcode::TBNZ => item.kind = "conditional_branch",
        Opcode::BR | Opcode::BRAA | Opcode::BRAB | Opcode::BRAAZ | Opcode::BRABZ => {
            item.kind = "indirect_branch";
            item.fallthrough = false;
            item.unresolved = Some("indirect target");
        }
        Opcode::BLR | Opcode::BLRAA | Opcode::BLRAB | Opcode::BLRAAZ | Opcode::BLRABZ => {
            item.kind = "indirect_call";
            item.unresolved = Some("indirect target");
        }
        Opcode::RET | Opcode::RETAA | Opcode::RETAB => {
            item.kind = "return";
            item.fallthrough = false;
            item.unresolved = Some("return target");
        }
        Opcode::ERET
        | Opcode::ERETAA
        | Opcode::ERETAB
        | Opcode::DRPS
        | Opcode::SVC
        | Opcode::HVC
        | Opcode::SMC
        | Opcode::BRK
        | Opcode::HLT
        | Opcode::DCPS1
        | Opcode::DCPS2
        | Opcode::DCPS3 => {
            item.kind = "system_transfer";
            item.fallthrough = false;
            item.unresolved = Some("exceptional/system control flow");
        }
        _ => {}
    }
    if matches!(item.kind, "branch" | "conditional_branch" | "call") {
        item.target = instruction
            .operands
            .iter()
            .find_map(|operand| match operand {
                Operand::PCOffset(displacement) => {
                    if *displacement < 0 {
                        item.address.checked_sub(displacement.unsigned_abs())
                    } else {
                        item.address.checked_add(*displacement as u64)
                    }
                }
                _ => None,
            });
        if item.target.is_none() {
            item.unresolved = Some("direct target missing or address overflow");
        }
    }
}

fn report(range: &Range<'_>, instructions: &[Decoded]) -> Value {
    let consumed: usize = instructions.iter().map(|item| item.length).sum();
    let invalid = instructions
        .last()
        .map(|item| item.kind == "invalid")
        .unwrap_or(false);
    let mut reasons = Vec::new();
    if range.requested > MAX_BYTES {
        reasons.push("byte_limit");
    }
    if consumed < range.bytes.len() && instructions.len() == MAX_INSTRUCTIONS {
        reasons.push("instruction_limit");
    }
    if invalid {
        reasons.push("invalid_instruction");
    }
    json!({
        "architecture": if range.arm { "arm64" } else if range.bitness == 64 { "x86_64" } else { "x86" },
        "bitness": range.bitness, "offset": range.offset,
        "address": format!("0x{:x}", range.address),
        "requestedLength": range.requested, "decodedBytes": consumed,
        "truncated": consumed < range.requested,
        "stopReasons": reasons, "maxBytes": MAX_BYTES, "maxInstructions": MAX_INSTRUCTIONS,
        "instructions": instructions.iter().map(|item| &item.record).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::{disassemble_arm64, function_flow};
    use serde_json::json;

    #[test]
    fn arm_real_decoder_and_direct_flow() {
        let bytes = [
            0x02, 0x00, 0x00, 0x94, 0x20, 0x00, 0x00, 0x54, 0xc0, 0x03, 0x5f, 0xd6,
        ];
        let result = function_flow(
            &bytes,
            &json!({"architecture":"arm64", "address":"0x1000000000000000"}),
        )
        .unwrap();
        assert_eq!(result["instructions"][0]["bytes"], "02000094");
        assert!(result["instructions"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("bl "));
        assert_eq!(result["edges"][0]["kind"], "call");
        assert_eq!(result["edges"][0]["target"], "0x1000000000000008");
        assert_eq!(result["edges"][1]["kind"], "conditional_branch");
        assert_eq!(result["edges"][2]["kind"], "return");
        assert_eq!(result["blocks"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn arm_invalid_partial_and_indirect() {
        for bytes in [&[0xff, 0xff, 0xff, 0xff][..], &[0x1f, 0x20][..]] {
            let result = disassemble_arm64(bytes, &json!({})).unwrap();
            assert_eq!(result["instructions"][0]["invalid"], true);
        }
        let result =
            function_flow(&[0x00, 0x00, 0x1f, 0xd6], &json!({"architecture":"arm64"})).unwrap();
        assert_eq!(result["edges"][0]["kind"], "indirect_branch");
        assert_eq!(result["edges"][0]["target"], serde_json::Value::Null);
    }

    #[test]
    fn x86_real_branches_calls_and_blocks() {
        let result = function_flow(
            &[0x75, 0x05, 0xe8, 0, 0, 0, 0, 0xff, 0xe0],
            &json!({"address":4096}),
        )
        .unwrap();
        assert_eq!(result["edges"][0]["target"], "0x1007");
        assert_eq!(result["edges"][1]["kind"], "call");
        assert_eq!(result["edges"][1]["target"], "0x1007");
        assert_eq!(result["edges"][2]["kind"], "indirect_branch");
        assert_eq!(result["blocks"].as_array().unwrap().len(), 3);
        let invalid = function_flow(&[0x0f], &json!({})).unwrap();
        assert_eq!(invalid["instructions"][0]["invalid"], true);
    }

    #[test]
    fn backward_branches_and_arm_instruction_cap() {
        let arm = function_flow(
            &[0xff, 0xff, 0xff, 0x17],
            &json!({"architecture":"arm64", "address":4}),
        )
        .unwrap();
        assert_eq!(arm["edges"][0]["target"], "0x0");
        assert_eq!(arm["blocks"][0]["successors"].as_array().unwrap().len(), 1);
        let overflow =
            function_flow(&[0xff, 0xff, 0xff, 0x17], &json!({"architecture":"arm64"})).unwrap();
        assert!(overflow["edges"][0]["target"].is_null());
        assert!(overflow["edges"][0]["unresolved"].is_string());
        let x86 = function_flow(&[0xeb, 0xfe], &json!({"bitness":32,"address":4096})).unwrap();
        assert_eq!(x86["edges"][0]["target"], "0x1000");
        let bytes = [0x1f, 0x20, 0x03, 0xd5].repeat(257);
        let capped = disassemble_arm64(&bytes, &json!({"length":bytes.len()})).unwrap();
        assert_eq!(capped["instructions"].as_array().unwrap().len(), 256);
        assert_eq!(capped["decodedBytes"], 1024);
        assert_eq!(capped["stopReasons"], json!(["instruction_limit"]));
    }

    #[test]
    fn bounds_and_caps() {
        for options in [
            json!({"offset":9}),
            json!({"length":9}),
            json!({"length":0}),
            json!({"offset":u64::MAX}),
            json!({"address":"0xffffffffffffffff"}),
            json!({"bitness":17}),
            json!({"offset":-1}),
        ] {
            assert!(function_flow(&[0x90; 8], &options).is_err());
        }
        assert!(disassemble_arm64(&[0; 4], &json!({"address":1})).is_err());
        let result = function_flow(&[0x90; 5000], &json!({"length":5000})).unwrap();
        assert_eq!(result["instructions"].as_array().unwrap().len(), 256);
        assert_eq!(result["decodedBytes"], 256);
        assert_eq!(result["truncated"], true);
        assert_eq!(
            result["stopReasons"],
            json!(["byte_limit", "instruction_limit"])
        );
    }
}
