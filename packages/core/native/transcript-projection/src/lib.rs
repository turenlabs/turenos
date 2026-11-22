use memchr::memmem;
use serde::Deserialize;
use serde_json::value::RawValue;
use std::cell::RefCell;
use std::io::Write;
use std::ops::Range;

const LIMIT: usize = 2 * 1024 * 1024;
const ELIDE: usize = 64 * 1024;

#[derive(Default)]
struct Buffers {
    input: Vec<u8>,
    output: Vec<u8>,
}

thread_local! {
    static BUFFERS: RefCell<Buffers> = RefCell::new(Buffers::default());
}

#[derive(Deserialize)]
struct Row<'a> {
    #[serde(borrow)]
    content: Vec<Part<'a>>,
}

#[derive(Deserialize)]
struct Part<'a> {
    #[serde(rename = "type", borrow)]
    kind: &'a str,
    #[serde(borrow)]
    state: Option<State<'a>>,
}

#[derive(Deserialize)]
struct State<'a> {
    #[serde(borrow)]
    status: &'a str,
    #[serde(borrow)]
    content: Option<Vec<Text<'a>>>,
    #[serde(borrow)]
    result: Option<&'a RawValue>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Text<'a> {
    #[serde(rename = "type", borrow)]
    kind: &'a str,
    #[serde(borrow)]
    text: &'a RawValue,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResultText<'a> {
    #[serde(rename = "type", borrow)]
    kind: &'a str,
    #[serde(borrow)]
    value: &'a RawValue,
}

fn literal_bytes(input: &RawValue) -> Option<&[u8]> {
    let bytes = input.get().as_bytes();
    let body = bytes.strip_prefix(b"\"")?.strip_suffix(b"\"")?;
    if body.len() < ELIDE / 4 {
        return None;
    }
    // These spellings can have a different size after parsing and re-encoding.
    // An escaped literal backslash before 'u' or '/' also takes the fallback.
    if memmem::find(body, b"\\u").is_some() || memmem::find(body, b"\\/").is_some() {
        return None;
    }
    Some(bytes)
}

fn compact(input: &[u8], output: &mut Vec<u8>) -> Option<()> {
    let row = serde_json::from_slice::<Row>(input).ok()?;
    let mut ranges = Vec::<Range<usize>>::new();
    let mut edits = Vec::new();
    for (position, part) in row.content.iter().enumerate() {
        if part.kind != "tool" {
            continue;
        }
        let Some(state) = &part.state else { continue };
        if !matches!(state.status, "completed" | "error") {
            continue;
        }
        let (Some([text]), Some(result)) = (state.content.as_deref(), state.result) else {
            continue;
        };
        if text.kind != "text" {
            continue;
        }
        let Ok(result) = serde_json::from_str::<ResultText>(result.get()) else {
            continue;
        };
        if result.kind != "text" {
            continue;
        }
        let (Some(text), Some(value)) = (literal_bytes(text.text), literal_bytes(result.value))
        else {
            continue;
        };
        let removed = text.len() + value.len() - 4;
        if removed <= ELIDE {
            continue;
        }
        for raw in [text, value] {
            let offset = raw.as_ptr() as usize - input.as_ptr() as usize;
            ranges.push(offset + 1..offset + raw.len() - 1);
        }
        edits.push((position, removed));
    }
    if edits.is_empty() {
        return None;
    }
    ranges.sort_unstable_by_key(|range| range.start);
    output.extend_from_slice(b"[[");
    for (index, (position, removed)) in edits.into_iter().enumerate() {
        if index != 0 {
            output.push(b',');
        }
        write!(output, "[{position},{removed}]").ok()?;
    }
    output.extend_from_slice(b"],");
    let mut previous = 0;
    for range in ranges {
        output.extend_from_slice(input.get(previous..range.start)?);
        previous = range.end;
    }
    output.extend_from_slice(input.get(previous..)?);
    output.push(b']');
    Some(())
}

#[unsafe(no_mangle)]
pub extern "C" fn reserve(length: usize) -> *mut u8 {
    if length > LIMIT {
        return std::ptr::null_mut();
    }
    BUFFERS.with_borrow_mut(|buffers| {
        buffers.input.resize(length, 0);
        buffers.input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn project() -> usize {
    BUFFERS.with_borrow_mut(|buffers| {
        buffers.output.clear();
        match compact(&buffers.input, &mut buffers.output) {
            Some(()) => buffers.output.len(),
            None => 0,
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn output() -> *const u8 {
    BUFFERS.with_borrow(|buffers| buffers.output.as_ptr())
}
