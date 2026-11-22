use std::{cell::RefCell, ffi::c_char, panic::catch_unwind, ptr, slice};
use tree_sitter::{Language, Parser};
use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_bash() -> *const ();
    fn tree_sitter_powershell() -> *const ();
}

fn language(shell: u32) -> Option<Language> {
    let grammar = match shell {
        0 => tree_sitter_bash,
        1 => tree_sitter_powershell,
        _ => return None,
    };
    Some(unsafe { LanguageFn::from_raw(grammar) }.into())
}

thread_local! {
    static PARSERS: RefCell<[Option<Parser>; 2]> = const { RefCell::new([None, None]) };
}

const WORDS: usize = 7;
const MAX_WORDS: usize = 1 + 262_144 * WORDS;

fn parse(input: &[u16], shell: u32) -> Option<Box<[u32]>> {
    let tree = PARSERS.with(|cell| {
        let mut parsers = cell.borrow_mut();
        let cache = parsers.get_mut(shell as usize)?;
        if cache.is_none() {
            let mut parser = Parser::new();
            parser.set_language(&language(shell)?).ok()?;
            *cache = Some(parser);
        }
        cache.as_mut()?.parse_utf16_le(input, None)
    })?;
    let mut rows = vec![0];
    let mut cursor = tree.walk();
    let mut parent = u32::MAX;
    loop {
        let index = (rows.len() - 1) / WORDS;
        let node = cursor.node();
        rows.extend_from_slice(&[
            node.kind_id() as u32,
            (node.start_byte() / 2) as u32,
            (node.end_byte() / 2) as u32,
            parent,
            0,
            node.child_count() as u32,
            u32::from(node.has_error()) | (u32::from(node.is_missing()) << 1),
        ]);
        if rows.len() > MAX_WORDS {
            return None;
        }
        if cursor.goto_first_child() {
            parent = index as u32;
            continue;
        }
        let end = ((rows.len() - 1) / WORDS) as u32;
        let mut closed = index;
        loop {
            let start = 1 + WORDS * closed;
            rows[start + 4] = end;
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                rows[0] = rows.len() as u32;
                return Some(rows.into_boxed_slice());
            }
            closed = parent as usize;
            parent = rows[1 + WORDS * closed + 3];
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn shell_abi() -> u32 {
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn shell_kind_count(shell: u32) -> u32 {
    language(shell).map_or(0, |grammar| grammar.node_kind_count() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn shell_kind(shell: u32, id: u32) -> *const c_char {
    // Tree-sitter borrows each name from the grammar's static C string table.
    language(shell)
        .and_then(|grammar| {
            grammar
                .node_kind_for_id(u16::try_from(id).ok()?)
                .map(|name| name.as_ptr().cast())
        })
        .unwrap_or(ptr::null())
}

/// # Safety
/// For a non-null input, the caller supplies at least `len` readable UTF-16 code units for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn shell_parse(input: *const u16, len: u32, shell: u32) -> *mut u32 {
    if input.is_null() || (input as usize) & 1 != 0 || len > 65_536 {
        return ptr::null_mut();
    }
    catch_unwind(|| parse(unsafe { slice::from_raw_parts(input, len as usize) }, shell))
        .ok()
        .flatten()
        .map_or(ptr::null_mut(), |rows| Box::into_raw(rows).cast())
}

/// # Safety
/// `rows` is a live, non-null pointer returned by `shell_parse`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn shell_words(rows: *const u32) -> u32 {
    unsafe { *rows }
}

/// # Safety
/// `rows` is a live, non-null pointer from `shell_parse` and is released exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn shell_free(rows: *mut u32) {
    let len = unsafe { *rows } as usize;
    drop(unsafe { Box::from_raw(ptr::slice_from_raw_parts_mut(rows, len)) });
}
