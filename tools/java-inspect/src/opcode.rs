//! Hand-rolled JVM opcode table plus a bounded javap-style disassembler.
//! The table covers every defined JVMS opcode; reserved/undefined slots have
//! an empty mnemonic and render as explicit `// WARNING: unknown opcode`
//! markers — unknown or truncated bytecode is never silently skipped.

use crate::classfile::ClassFile;
use crate::MAX_SWITCH_CASES;

/// Operand shape for one opcode.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Oper {
    /// No operand bytes.
    None,
    /// One unsigned byte (local-variable index, ret).
    U1,
    /// One signed byte (bipush).
    I1,
    /// One signed short (sipush).
    I2,
    /// One-byte constant-pool index (ldc).
    Cp1,
    /// Two-byte constant-pool index.
    Cp2,
    /// Signed 16-bit branch offset.
    Branch2,
    /// Signed 32-bit branch offset (goto_w, jsr_w).
    Branch4,
    /// iinc: u1 index + s1 constant.
    Iinc,
    /// invokeinterface: cp2 + u1 count + u1 zero.
    InvokeInterface,
    /// invokedynamic: cp2 + u2 zero.
    InvokeDynamic,
    /// newarray: u1 atype.
    NewArray,
    /// multianewarray: cp2 + u1 dimensions.
    MultiANew,
    /// tableswitch variable payload.
    TableSwitch,
    /// lookupswitch variable payload.
    LookupSwitch,
    /// wide prefix.
    Wide,
}

/// (mnemonic, operand kind) for every byte value; "" = undefined/reserved.
pub(crate) const OPCODES: [(&str, Oper); 256] = [
    ("nop", Oper::None),                   // 0x00
    ("aconst_null", Oper::None),           // 0x01
    ("iconst_m1", Oper::None),             // 0x02
    ("iconst_0", Oper::None),              // 0x03
    ("iconst_1", Oper::None),              // 0x04
    ("iconst_2", Oper::None),              // 0x05
    ("iconst_3", Oper::None),              // 0x06
    ("iconst_4", Oper::None),              // 0x07
    ("iconst_5", Oper::None),              // 0x08
    ("lconst_0", Oper::None),              // 0x09
    ("lconst_1", Oper::None),              // 0x0a
    ("fconst_0", Oper::None),              // 0x0b
    ("fconst_1", Oper::None),              // 0x0c
    ("fconst_2", Oper::None),              // 0x0d
    ("dconst_0", Oper::None),              // 0x0e
    ("dconst_1", Oper::None),              // 0x0f
    ("bipush", Oper::I1),                  // 0x10
    ("sipush", Oper::I2),                  // 0x11
    ("ldc", Oper::Cp1),                    // 0x12
    ("ldc_w", Oper::Cp2),                  // 0x13
    ("ldc2_w", Oper::Cp2),                 // 0x14
    ("iload", Oper::U1),                   // 0x15
    ("lload", Oper::U1),                   // 0x16
    ("fload", Oper::U1),                   // 0x17
    ("dload", Oper::U1),                   // 0x18
    ("aload", Oper::U1),                   // 0x19
    ("iload_0", Oper::None),               // 0x1a
    ("iload_1", Oper::None),               // 0x1b
    ("iload_2", Oper::None),               // 0x1c
    ("iload_3", Oper::None),               // 0x1d
    ("lload_0", Oper::None),               // 0x1e
    ("lload_1", Oper::None),               // 0x1f
    ("lload_2", Oper::None),               // 0x20
    ("lload_3", Oper::None),               // 0x21
    ("fload_0", Oper::None),               // 0x22
    ("fload_1", Oper::None),               // 0x23
    ("fload_2", Oper::None),               // 0x24
    ("fload_3", Oper::None),               // 0x25
    ("dload_0", Oper::None),               // 0x26
    ("dload_1", Oper::None),               // 0x27
    ("dload_2", Oper::None),               // 0x28
    ("dload_3", Oper::None),               // 0x29
    ("aload_0", Oper::None),               // 0x2a
    ("aload_1", Oper::None),               // 0x2b
    ("aload_2", Oper::None),               // 0x2c
    ("aload_3", Oper::None),               // 0x2d
    ("iaload", Oper::None),                // 0x2e
    ("laload", Oper::None),                // 0x2f
    ("faload", Oper::None),                // 0x30
    ("daload", Oper::None),                // 0x31
    ("aaload", Oper::None),                // 0x32
    ("baload", Oper::None),                // 0x33
    ("caload", Oper::None),                // 0x34
    ("saload", Oper::None),                // 0x35
    ("istore", Oper::U1),                  // 0x36
    ("lstore", Oper::U1),                  // 0x37
    ("fstore", Oper::U1),                  // 0x38
    ("dstore", Oper::U1),                  // 0x39
    ("astore", Oper::U1),                  // 0x3a
    ("istore_0", Oper::None),              // 0x3b
    ("istore_1", Oper::None),              // 0x3c
    ("istore_2", Oper::None),              // 0x3d
    ("istore_3", Oper::None),              // 0x3e
    ("lstore_0", Oper::None),              // 0x3f
    ("lstore_1", Oper::None),              // 0x40
    ("lstore_2", Oper::None),              // 0x41
    ("lstore_3", Oper::None),              // 0x42
    ("fstore_0", Oper::None),              // 0x43
    ("fstore_1", Oper::None),              // 0x44
    ("fstore_2", Oper::None),              // 0x45
    ("fstore_3", Oper::None),              // 0x46
    ("dstore_0", Oper::None),              // 0x47
    ("dstore_1", Oper::None),              // 0x48
    ("dstore_2", Oper::None),              // 0x49
    ("dstore_3", Oper::None),              // 0x4a
    ("astore_0", Oper::None),              // 0x4b
    ("astore_1", Oper::None),              // 0x4c
    ("astore_2", Oper::None),              // 0x4d
    ("astore_3", Oper::None),              // 0x4e
    ("iastore", Oper::None),               // 0x4f
    ("lastore", Oper::None),               // 0x50
    ("fastore", Oper::None),               // 0x51
    ("dastore", Oper::None),               // 0x52
    ("aastore", Oper::None),               // 0x53
    ("bastore", Oper::None),               // 0x54
    ("castore", Oper::None),               // 0x55
    ("sastore", Oper::None),               // 0x56
    ("pop", Oper::None),                   // 0x57
    ("pop2", Oper::None),                  // 0x58
    ("dup", Oper::None),                   // 0x59
    ("dup_x1", Oper::None),                // 0x5a
    ("dup_x2", Oper::None),                // 0x5b
    ("dup2", Oper::None),                  // 0x5c
    ("dup2_x1", Oper::None),               // 0x5d
    ("dup2_x2", Oper::None),               // 0x5e
    ("swap", Oper::None),                  // 0x5f
    ("iadd", Oper::None),                  // 0x60
    ("ladd", Oper::None),                  // 0x61
    ("fadd", Oper::None),                  // 0x62
    ("dadd", Oper::None),                  // 0x63
    ("isub", Oper::None),                  // 0x64
    ("lsub", Oper::None),                  // 0x65
    ("fsub", Oper::None),                  // 0x66
    ("dsub", Oper::None),                  // 0x67
    ("imul", Oper::None),                  // 0x68
    ("lmul", Oper::None),                  // 0x69
    ("fmul", Oper::None),                  // 0x6a
    ("dmul", Oper::None),                  // 0x6b
    ("idiv", Oper::None),                  // 0x6c
    ("ldiv", Oper::None),                  // 0x6d
    ("fdiv", Oper::None),                  // 0x6e
    ("ddiv", Oper::None),                  // 0x6f
    ("irem", Oper::None),                  // 0x70
    ("lrem", Oper::None),                  // 0x71
    ("frem", Oper::None),                  // 0x72
    ("drem", Oper::None),                  // 0x73
    ("ineg", Oper::None),                  // 0x74
    ("lneg", Oper::None),                  // 0x75
    ("fneg", Oper::None),                  // 0x76
    ("dneg", Oper::None),                  // 0x77
    ("ishl", Oper::None),                  // 0x78
    ("lshl", Oper::None),                  // 0x79
    ("ishr", Oper::None),                  // 0x7a
    ("lshr", Oper::None),                  // 0x7b
    ("iushr", Oper::None),                 // 0x7c
    ("lushr", Oper::None),                 // 0x7d
    ("iand", Oper::None),                  // 0x7e
    ("land", Oper::None),                  // 0x7f
    ("ior", Oper::None),                   // 0x80
    ("lor", Oper::None),                   // 0x81
    ("ixor", Oper::None),                  // 0x82
    ("lxor", Oper::None),                  // 0x83
    ("iinc", Oper::Iinc),                  // 0x84
    ("i2l", Oper::None),                   // 0x85
    ("i2f", Oper::None),                   // 0x86
    ("i2d", Oper::None),                   // 0x87
    ("l2i", Oper::None),                   // 0x88
    ("l2f", Oper::None),                   // 0x89
    ("l2d", Oper::None),                   // 0x8a
    ("f2i", Oper::None),                   // 0x8b
    ("f2l", Oper::None),                   // 0x8c
    ("f2d", Oper::None),                   // 0x8d
    ("d2i", Oper::None),                   // 0x8e
    ("d2l", Oper::None),                   // 0x8f
    ("d2f", Oper::None),                   // 0x90
    ("i2b", Oper::None),                   // 0x91
    ("i2c", Oper::None),                   // 0x92
    ("i2s", Oper::None),                   // 0x93
    ("lcmp", Oper::None),                  // 0x94
    ("fcmpl", Oper::None),                 // 0x95
    ("fcmpg", Oper::None),                 // 0x96
    ("dcmpl", Oper::None),                 // 0x97
    ("dcmpg", Oper::None),                 // 0x98
    ("ifeq", Oper::Branch2),               // 0x99
    ("ifne", Oper::Branch2),               // 0x9a
    ("iflt", Oper::Branch2),               // 0x9b
    ("ifge", Oper::Branch2),               // 0x9c
    ("ifgt", Oper::Branch2),               // 0x9d
    ("ifle", Oper::Branch2),               // 0x9e
    ("if_icmpeq", Oper::Branch2),          // 0x9f
    ("if_icmpne", Oper::Branch2),          // 0xa0
    ("if_icmplt", Oper::Branch2),          // 0xa1
    ("if_icmpge", Oper::Branch2),          // 0xa2
    ("if_icmpgt", Oper::Branch2),          // 0xa3
    ("if_icmple", Oper::Branch2),          // 0xa4
    ("if_acmpeq", Oper::Branch2),          // 0xa5
    ("if_acmpne", Oper::Branch2),          // 0xa6
    ("goto", Oper::Branch2),               // 0xa7
    ("jsr", Oper::Branch2),                // 0xa8
    ("ret", Oper::U1),                     // 0xa9
    ("tableswitch", Oper::TableSwitch),    // 0xaa
    ("lookupswitch", Oper::LookupSwitch),  // 0xab
    ("ireturn", Oper::None),               // 0xac
    ("lreturn", Oper::None),               // 0xad
    ("freturn", Oper::None),               // 0xae
    ("dreturn", Oper::None),               // 0xaf
    ("areturn", Oper::None),               // 0xb0
    ("return", Oper::None),                // 0xb1
    ("getstatic", Oper::Cp2),              // 0xb2
    ("putstatic", Oper::Cp2),              // 0xb3
    ("getfield", Oper::Cp2),               // 0xb4
    ("putfield", Oper::Cp2),               // 0xb5
    ("invokevirtual", Oper::Cp2),          // 0xb6
    ("invokespecial", Oper::Cp2),          // 0xb7
    ("invokestatic", Oper::Cp2),           // 0xb8
    ("invokeinterface", Oper::InvokeInterface), // 0xb9
    ("invokedynamic", Oper::InvokeDynamic),// 0xba
    ("new", Oper::Cp2),                    // 0xbb
    ("newarray", Oper::NewArray),          // 0xbc
    ("anewarray", Oper::Cp2),              // 0xbd
    ("arraylength", Oper::None),           // 0xbe
    ("athrow", Oper::None),                // 0xbf
    ("checkcast", Oper::Cp2),              // 0xc0
    ("instanceof", Oper::Cp2),             // 0xc1
    ("monitorenter", Oper::None),          // 0xc2
    ("monitorexit", Oper::None),           // 0xc3
    ("wide", Oper::Wide),                  // 0xc4
    ("multianewarray", Oper::MultiANew),   // 0xc5
    ("ifnull", Oper::Branch2),             // 0xc6
    ("ifnonnull", Oper::Branch2),          // 0xc7
    ("goto_w", Oper::Branch4),             // 0xc8
    ("jsr_w", Oper::Branch4),              // 0xc9
    ("breakpoint", Oper::None),            // 0xca (reserved)
    ("", Oper::None),                      // 0xcb
    ("", Oper::None),                      // 0xcc
    ("", Oper::None),                      // 0xcd
    ("", Oper::None),                      // 0xce
    ("", Oper::None),                      // 0xcf
    ("", Oper::None),                      // 0xd0
    ("", Oper::None),                      // 0xd1
    ("", Oper::None),                      // 0xd2
    ("", Oper::None),                      // 0xd3
    ("", Oper::None),                      // 0xd4
    ("", Oper::None),                      // 0xd5
    ("", Oper::None),                      // 0xd6
    ("", Oper::None),                      // 0xd7
    ("", Oper::None),                      // 0xd8
    ("", Oper::None),                      // 0xd9
    ("", Oper::None),                      // 0xda
    ("", Oper::None),                      // 0xdb
    ("", Oper::None),                      // 0xdc
    ("", Oper::None),                      // 0xdd
    ("", Oper::None),                      // 0xde
    ("", Oper::None),                      // 0xdf
    ("", Oper::None),                      // 0xe0
    ("", Oper::None),                      // 0xe1
    ("", Oper::None),                      // 0xe2
    ("", Oper::None),                      // 0xe3
    ("", Oper::None),                      // 0xe4
    ("", Oper::None),                      // 0xe5
    ("", Oper::None),                      // 0xe6
    ("", Oper::None),                      // 0xe7
    ("", Oper::None),                      // 0xe8
    ("", Oper::None),                      // 0xe9
    ("", Oper::None),                      // 0xea
    ("", Oper::None),                      // 0xeb
    ("", Oper::None),                      // 0xec
    ("", Oper::None),                      // 0xed
    ("", Oper::None),                      // 0xee
    ("", Oper::None),                      // 0xef
    ("", Oper::None),                      // 0xf0
    ("", Oper::None),                      // 0xf1
    ("", Oper::None),                      // 0xf2
    ("", Oper::None),                      // 0xf3
    ("", Oper::None),                      // 0xf4
    ("", Oper::None),                      // 0xf5
    ("", Oper::None),                      // 0xf6
    ("", Oper::None),                      // 0xf7
    ("", Oper::None),                      // 0xf8
    ("", Oper::None),                      // 0xf9
    ("", Oper::None),                      // 0xfa
    ("", Oper::None),                      // 0xfb
    ("", Oper::None),                      // 0xfc
    ("", Oper::None),                      // 0xfd
    ("impdep1", Oper::None),               // 0xfe (reserved)
    ("impdep2", Oper::None),               // 0xff (reserved)
];

/// newarray atype values (JVMS §6.5).
fn atype_name(atype: u8) -> &'static str {
    match atype {
        4 => "boolean",
        5 => "char",
        6 => "float",
        7 => "double",
        8 => "byte",
        9 => "short",
        10 => "int",
        11 => "long",
        _ => "unknown",
    }
}

fn be_u16(bytes: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([bytes[at], bytes[at + 1]])
}

fn be_i16(bytes: &[u8], at: usize) -> i16 {
    i16::from_be_bytes([bytes[at], bytes[at + 1]])
}

fn be_i32(bytes: &[u8], at: usize) -> i32 {
    i32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// One disassembled instruction line (or warning line).
pub(crate) struct Line {
    /// Byte offset of the instruction; `None` for continuation/warning rows.
    pub offset: Option<usize>,
    pub text: String,
}

/// Emit a `// WARNING` listing row and record it in the report's warnings.
fn warn(
    lines: &mut Vec<Line>,
    warnings: &mut Vec<String>,
    max_warnings: usize,
    message: String,
) {
    lines.push(Line {
        offset: None,
        text: format!("// WARNING: {message}"),
    });
    if warnings.len() < max_warnings {
        warnings.push(message);
    }
}

/// Disassemble `code` (a Code attribute's bytecode) into javap-style lines.
/// Stops with an explicit WARNING line on unknown opcodes or truncated
/// operands — continuation is impossible when the length is unknowable.
pub(crate) fn disassemble_code(
    code: &[u8],
    class: &ClassFile,
    warnings: &mut Vec<String>,
    max_warnings: usize,
) -> Vec<Line> {
    let mut lines = Vec::new();
    macro_rules! warn {
        ($($arg:tt)*) => {
            warn(&mut lines, warnings, max_warnings, format!($($arg)*))
        };
    }
    let mut pc = 0usize;
    while pc < code.len() {
        let opcode = code[pc];
        let (mnemonic, oper) = OPCODES[opcode as usize];
        if mnemonic.is_empty() {
            warn!("unknown opcode 0x{opcode:02x} at offset {pc}; disassembly stopped");
            break;
        }
        // Fixed-width operands bounds-checked up front.
        let operand_len = match oper {
            Oper::None => 0,
            Oper::U1 | Oper::I1 | Oper::Cp1 | Oper::NewArray => 1,
            Oper::I2 | Oper::Cp2 | Oper::Branch2 | Oper::Iinc => 2,
            Oper::InvokeInterface | Oper::InvokeDynamic => 4,
            Oper::Branch4 => 4,
            Oper::MultiANew => 3,
            Oper::TableSwitch | Oper::LookupSwitch | Oper::Wide => usize::MAX,
        };
        if operand_len != usize::MAX && code.len() - pc - 1 < operand_len {
            warn!("truncated operand for {mnemonic} at offset {pc}; disassembly stopped");
            break;
        }
        let operand_at = pc + 1;
        let mut operand = String::new();
        let mut comment = String::new();
        let advance = match oper {
            Oper::None => 1,
            Oper::U1 => {
                operand = format!("{}", code[operand_at]);
                2
            }
            Oper::I1 => {
                operand = format!("{}", code[operand_at] as i8);
                2
            }
            Oper::I2 => {
                operand = format!("{}", be_i16(code, operand_at));
                3
            }
            Oper::Cp1 => {
                let index = code[operand_at] as u16;
                operand = format!("#{index}");
                comment = class.describe_cp(index);
                2
            }
            Oper::Cp2 => {
                let index = be_u16(code, operand_at);
                operand = format!("#{index}");
                comment = class.describe_cp(index);
                3
            }
            Oper::Branch2 => {
                let target = pc as i64 + be_i16(code, operand_at) as i64;
                operand = format!("{target}");
                3
            }
            Oper::Branch4 => {
                let target = pc as i64 + be_i32(code, operand_at) as i64;
                operand = format!("{target}");
                5
            }
            Oper::Iinc => {
                operand = format!(
                    "{} {}",
                    code[operand_at],
                    code[operand_at + 1] as i8
                );
                3
            }
            Oper::InvokeInterface | Oper::InvokeDynamic => {
                let index = be_u16(code, operand_at);
                let third = code[operand_at + 2];
                operand = format!("#{index} {third}");
                comment = class.describe_cp(index);
                5
            }
            Oper::NewArray => {
                let atype = code[operand_at];
                operand = atype_name(atype).to_string();
                if atype_name(atype) == "unknown" {
                    comment = format!("WARNING: unknown atype {atype}");
                }
                2
            }
            Oper::MultiANew => {
                let index = be_u16(code, operand_at);
                operand = format!("#{index} {}", code[operand_at + 2]);
                comment = class.describe_cp(index);
                4
            }
            Oper::Wide => {
                // wide <opcode> <u2 index>: 3 operand bytes minimum.
                if code.len() - operand_at < 3 {
                    warn!("truncated wide prefix at offset {pc}; disassembly stopped");
                    break;
                }
                let widened = code[operand_at];
                let (wide_mnemonic, _) = OPCODES[widened as usize];
                let index = be_u16(code, operand_at + 1);
                if wide_mnemonic.is_empty() {
                    warn!("wide applied to unknown opcode 0x{widened:02x} at offset {pc}; disassembly stopped");
                    break;
                }
                if widened == 0x84 {
                    // wide iinc: u2 index + s2 const = 5 operand bytes.
                    if code.len() - operand_at < 5 {
                        warn!("truncated wide iinc at offset {pc}; disassembly stopped");
                        break;
                    }
                    let constant = be_i16(code, operand_at + 3);
                    operand = format!("iinc {index} {constant}");
                    6
                } else {
                    operand = format!("{wide_mnemonic} {index}");
                    4
                }
            }
            Oper::TableSwitch => {
                let body = operand_at + (4 - (operand_at % 4)) % 4;
                if code.len() < body + 12 {
                    warn!("truncated tableswitch at offset {pc}; disassembly stopped");
                    break;
                }
                let default = be_i32(code, body);
                let low = be_i32(code, body + 4);
                let high = be_i32(code, body + 8);
                let count = (high as i64 - low as i64 + 1).max(0);
                let bytes_needed = 12i64 + count.saturating_mul(4);
                if ((code.len() - body) as i64) < bytes_needed {
                    warn!("malformed tableswitch at offset {pc} (low={low} high={high}); disassembly stopped");
                    break;
                }
                lines.push(Line {
                    offset: Some(pc),
                    text: format!("{mnemonic} {{ // {low} to {high}"),
                });
                let shown = count.min(MAX_SWITCH_CASES as i64);
                for i in 0..shown {
                    let target = pc as i64 + be_i32(code, body + 12 + i as usize * 4) as i64;
                    lines.push(Line {
                        offset: None,
                        text: format!("            {}: {target}", low as i64 + i),
                    });
                }
                if count > shown {
                    lines.push(Line {
                        offset: None,
                        text: format!(
                            "            // WARNING: {count} tableswitch cases truncated at {MAX_SWITCH_CASES}"
                        ),
                    });
                }
                lines.push(Line {
                    offset: None,
                    text: format!("            default: {}", pc as i64 + default as i64),
                });
                lines.push(Line {
                    offset: None,
                    text: "}".to_string(),
                });
                body + bytes_needed as usize - pc
            }
            Oper::LookupSwitch => {
                let body = operand_at + (4 - (operand_at % 4)) % 4;
                if code.len() < body + 8 {
                    warn!("truncated lookupswitch at offset {pc}; disassembly stopped");
                    break;
                }
                let default = be_i32(code, body);
                let pairs = be_i32(code, body + 4);
                if pairs < 0 || (code.len() - body - 8) / 8 < pairs as usize {
                    warn!("malformed lookupswitch at offset {pc} (pairs={pairs}); disassembly stopped");
                    break;
                }
                lines.push(Line {
                    offset: Some(pc),
                    text: format!("{mnemonic} {{ // {pairs} pairs"),
                });
                let shown = (pairs as usize).min(MAX_SWITCH_CASES);
                for i in 0..shown {
                    let at = body + 8 + i * 8;
                    let match_value = be_i32(code, at);
                    let target = pc as i64 + be_i32(code, at + 4) as i64;
                    lines.push(Line {
                        offset: None,
                        text: format!("            {match_value}: {target}"),
                    });
                }
                if pairs as usize > shown {
                    lines.push(Line {
                        offset: None,
                        text: format!(
                            "            // WARNING: {} pairs truncated at {MAX_SWITCH_CASES}",
                            mnemonic
                        ),
                    });
                }
                lines.push(Line {
                    offset: None,
                    text: format!("            default: {}", pc as i64 + default as i64),
                });
                lines.push(Line {
                    offset: None,
                    text: "}".to_string(),
                });
                body + 8 + pairs as usize * 8 - pc
            }
        };
        // Switch arms emit their own multi-line blocks; other instructions
        // render one line from mnemonic + operand + inline comment.
        if !matches!(oper, Oper::TableSwitch | Oper::LookupSwitch) {
            let mut text = mnemonic.to_string();
            if !operand.is_empty() {
                text.push(' ');
                text.push_str(&operand);
            }
            if !comment.is_empty() {
                while text.len() < 28 {
                    text.push(' ');
                }
                text.push_str("// ");
                text.push_str(&comment);
            }
            lines.push(Line {
                offset: Some(pc),
                text,
            });
        }
        pc += advance;
    }
    lines
}

/// Render lines to javap-style text: right-aligned offset, instruction text.
pub(crate) fn render_lines(lines: &[Line]) -> String {
    let mut out = String::new();
    for line in lines {
        match line.offset {
            Some(offset) => out.push_str(&format!("{offset:7}: {}\n", line.text)),
            None => out.push_str(&format!("    {}\n", line.text)),
        }
    }
    out
}



