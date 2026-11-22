use std::cell::RefCell;

const CAPACITY: usize = 256 * 1024;

// The host writes input and reads output between synchronous calls. Rust
// borrows the buffers only while executing the repair.
thread_local! {
    static INPUT: RefCell<[u8; CAPACITY]> = const { RefCell::new([0; CAPACITY]) };
    static OUTPUT: RefCell<[u32; 2]> = const { RefCell::new([0; 2]) };
}

const KEEP: u32 = 0;
const REMOVE_OPEN: u32 = 1;
const KEEP_LABEL: u32 = 2;
const CUT_IMAGE: u32 = 3;
const FALLBACK: u32 = 4;

struct Opening {
    position: usize,
    parent: Option<usize>,
    close: Option<usize>,
    in_code: bool,
    image: bool,
}

fn plan(text: &[u8]) -> (u32, usize, usize) {
    let mut openings = Vec::<Opening>::new();
    let mut last_open = None;
    let mut inline = false;
    let mut fenced = false;
    let mut last_destination = None;
    let mut last_parenthesis = None;
    let mut index = 0;
    while index < text.len() {
        let in_code = inline || fenced;
        match text[index] {
            b'\\' if text.get(index + 1) == Some(&b'`') => {
                index += 2;
                continue;
            }
            b'`' if text.get(index + 1..index + 3) == Some(b"``") => {
                fenced = !fenced;
                index += 3;
                continue;
            }
            b'`' if !fenced => inline = !inline,
            b'[' => {
                let image = index > 0 && text[index - 1] == b'!';
                openings.push(Opening {
                    position: index,
                    parent: last_open,
                    close: None,
                    in_code,
                    image,
                });
                last_open = Some(openings.len() - 1);
            }
            b']' => {
                if text.get(index + 1) == Some(&b'(') {
                    last_destination = Some((index, in_code, last_open));
                }
                if let Some(open) = last_open {
                    openings[open].close = Some(index);
                    last_open = openings[open].parent;
                }
            }
            b')' => last_parenthesis = Some(index),
            _ => (),
        }
        index += 1;
    }

    if let Some((close, false, Some(open))) = last_destination {
        let open = &openings[open];
        if !open.in_code && last_parenthesis.is_none_or(|parenthesis| parenthesis <= close + 1) {
            if open.image {
                return (CUT_IMAGE, open.position - 1, 0);
            }
            return (KEEP_LABEL, open.position, close);
        }
    }

    let Some(pending) = openings
        .iter()
        .rfind(|open| !open.in_code && open.close.is_none())
    else {
        return (KEEP, 0, 0);
    };
    if pending.image {
        return (CUT_IMAGE, pending.position - 1, 0);
    }

    // As in text-only repair, earlier unmatched labels can make the newest
    // opening ambiguous. Traverse complete destinations once as we skip them.
    let mut skip_through = 0;
    for open in openings
        .iter()
        .take_while(|open| open.position < pending.position)
    {
        if open.in_code || open.image || open.position < skip_through {
            continue;
        }
        let Some(close) = open.close else {
            return (REMOVE_OPEN, open.position, 0);
        };
        let start = close + 2;
        if text.get(close + 1) == Some(&b'(')
            && last_parenthesis.is_some_and(|parenthesis| parenthesis >= start)
        {
            if let Some(end) = text[start..].iter().position(|byte| *byte == b')') {
                skip_through = start + end + 1;
            }
        }
    }
    (REMOVE_OPEN, pending.position, 0)
}

fn utf16_offset(text: &[u8], index: usize) -> u32 {
    text[..index]
        .iter()
        .map(|byte| match byte {
            0x80..=0xbf => 0,
            0xf0..=0xff => 2,
            _ => 1,
        })
        .sum()
}

#[no_mangle]
pub extern "C" fn input_ptr() -> *mut u8 {
    INPUT.with(|input| input.as_ptr().cast())
}

#[no_mangle]
pub extern "C" fn output_ptr() -> *mut u32 {
    OUTPUT.with(|output| output.as_ptr().cast())
}

#[no_mangle]
pub extern "C" fn repair_links(length: usize) -> u32 {
    INPUT.with_borrow(|input| {
        let Some(text) = input.get(..length) else {
            return FALLBACK;
        };
        let (kind, start, end) = plan(text);
        if kind != KEEP {
            OUTPUT.with_borrow_mut(|output| {
                *output = [utf16_offset(text, start), utf16_offset(text, end)];
            });
        }
        kind
    })
}
