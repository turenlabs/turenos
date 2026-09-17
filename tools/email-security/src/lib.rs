use ammonia::{Builder, UrlRelative};
use mail_parser::{Addr, Address as ParsedAddress, HeaderValue, MessageParser, MimeHeaders};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_HEADERS: usize = 512;
const MAX_ATTACHMENTS: usize = 256;
const MAX_IOCS: usize = 2048;
const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;
const MAX_VALUE_BYTES: usize = 64 * 1024;
const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default, Deserialize)]
struct Options {
    #[serde(default)]
    include_bodies: bool,
    #[serde(default)]
    include_attachment_data: bool,
    #[serde(default)]
    max_iocs: Option<usize>,
}

#[derive(Serialize)]
struct Report {
    schema_version: u32,
    subject: Option<String>,
    from: Vec<Address>,
    to: Vec<Address>,
    reply_to: Vec<Address>,
    headers: Vec<Header>,
    attachments: Vec<Attachment>,
    bodies: Vec<Body>,
    iocs: Vec<Ioc>,
    signals: Vec<Signal>,
    truncated: bool,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct Address {
    name: Option<String>,
    address: String,
}

#[derive(Serialize)]
struct Header {
    name: String,
    value: String,
}

#[derive(Serialize)]
struct Attachment {
    index: usize,
    name: Option<String>,
    content_type: Option<String>,
    size: usize,
    content_id: Option<String>,
    inline: bool,
}

#[derive(Serialize)]
struct Body {
    content_type: String,
    value: String,
}

#[derive(Serialize, Ord, PartialOrd, Eq, PartialEq)]
struct Ioc {
    kind: String,
    value: String,
}

#[derive(Serialize)]
struct Signal {
    code: String,
    severity: String,
    detail: String,
}

#[wasm_bindgen]
pub fn inspect(bytes: &[u8], options_json: &str) -> String {
    match inspect_inner(bytes, options_json) {
        Ok(report) => {
            serde_json::to_string(&report).unwrap_or_else(|_| error_json("serialization_error"))
        }
        Err(error) => error_json(error),
    }
}

#[wasm_bindgen]
pub fn extract_attachment(
    bytes: &[u8],
    index: f64,
    max_output_bytes: f64,
) -> Result<Vec<u8>, JsValue> {
    extract_attachment_inner(bytes, index, max_output_bytes).map_err(JsValue::from_str)
}

fn extract_attachment_inner(
    bytes: &[u8],
    index: f64,
    max_output_bytes: f64,
) -> Result<Vec<u8>, &'static str> {
    // Floating-point ABI parameters avoid wasm-bindgen's silent u32 wrapping/truncation.
    if !index.is_finite() || index.fract() != 0.0 || !(0.0..MAX_ATTACHMENTS as f64).contains(&index)
    {
        return Err("invalid_attachment_index");
    }
    if !max_output_bytes.is_finite()
        || max_output_bytes.fract() != 0.0
        || !(1.0..=MAX_ATTACHMENT_BYTES as f64).contains(&max_output_bytes)
    {
        return Err("invalid_max_output_bytes");
    }
    if bytes.is_empty() {
        return Err("empty_message");
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("message_too_large");
    }
    // mail-parser decodes during parsing; the input cap bounds that work. Check the
    // selected decoded slice before allocating the returned vector/JS byte array.
    let message = MessageParser::default()
        .parse(bytes)
        .ok_or("invalid_message")?;
    let attachment = message
        .attachments()
        .nth(index as usize)
        .ok_or("attachment_not_found")?;
    if attachment.is_encoding_problem {
        return Err("attachment_encoding_error");
    }
    let contents = attachment.contents();
    if contents.len() > max_output_bytes as usize {
        return Err("attachment_too_large");
    }
    Ok(contents.to_vec())
}

#[wasm_bindgen]
pub fn sanitize_html(html: &str) -> String {
    if html.len() > MAX_HTML_BYTES {
        return error_json("html_too_large");
    }
    serde_json::json!({
        "schema_version": 1,
        "html": sanitize(html),
        "truncated": false,
    })
    .to_string()
}

fn sanitize(html: &str) -> String {
    let mut builder = Builder::default();
    builder
        .rm_tags(&[
            "form", "input", "button", "textarea", "select", "option", "meta", "base",
        ])
        .add_clean_content_tags(["form"])
        .rm_generic_attributes(&["style"])
        .url_schemes(["http", "https", "cid"].into())
        .url_relative(UrlRelative::Deny);
    builder.clean(html).to_string()
}

fn inspect_inner(bytes: &[u8], options_json: &str) -> Result<Report, &'static str> {
    if bytes.is_empty() {
        return Err("empty_message");
    }
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("message_too_large");
    }
    let options = serde_json::from_str::<Options>(options_json).map_err(|_| "invalid_options")?;
    let message = MessageParser::default()
        .parse(bytes)
        .ok_or("invalid_message")?;
    let mut truncated = false;
    let mut warnings = Vec::new();

    let headers = message
        .headers()
        .into_iter()
        .take(MAX_HEADERS)
        .map(|header| Header {
            name: header.name().to_string(),
            value: truncate(
                header_value_text(header.value()),
                MAX_VALUE_BYTES,
                &mut truncated,
            ),
        })
        .collect::<Vec<_>>();
    if message.headers().len() > MAX_HEADERS {
        truncated = true;
        warnings.push("header count exceeded limit".to_string());
    }

    let mut bodies = Vec::new();
    if options.include_bodies {
        for part in message
            .text_bodies()
            .filter(|part| !part.is_text_html())
            .take(MAX_ATTACHMENTS)
        {
            if let Some(text) = part.text_contents() {
                bodies.push(Body {
                    content_type: "text/plain".to_string(),
                    value: truncate(text.to_string(), MAX_TEXT_BYTES, &mut truncated),
                });
            }
        }
        for part in message
            .html_bodies()
            .filter(|part| part.is_text_html())
            .take(MAX_ATTACHMENTS)
        {
            if let Some(html) = part.text_contents() {
                bodies.push(Body {
                    content_type: "text/html".to_string(),
                    value: truncate(html.to_string(), MAX_TEXT_BYTES, &mut truncated),
                });
            }
        }
    }

    let attachments = message
        .attachments()
        .take(MAX_ATTACHMENTS)
        .enumerate()
        .map(|(index, attachment)| Attachment {
            index,
            name: attachment
                .attachment_name()
                .map(|value| truncate(value.to_string(), 4096, &mut truncated)),
            content_type: attachment.content_type().map(|value| {
                value.c_subtype.as_ref().map_or_else(
                    || value.c_type.to_string(),
                    |subtype| format!("{}/{}", value.c_type, subtype),
                )
            }),
            size: attachment.len(),
            content_id: attachment.content_id().map(ToString::to_string),
            inline: attachment
                .content_disposition()
                .is_some_and(|value| value.is_inline()),
        })
        .collect::<Vec<_>>();
    if message.attachments().count() > MAX_ATTACHMENTS {
        truncated = true;
        warnings.push("attachment count exceeded limit".to_string());
    }

    let max_iocs = options.max_iocs.unwrap_or(MAX_IOCS).min(MAX_IOCS);
    let scan_text = collect_scan_text(
        bytes,
        &headers,
        &bodies,
        &attachments,
        options.include_attachment_data,
    );
    let iocs = extract_iocs(&scan_text, max_iocs, &mut truncated);
    let signals = score_signals(&headers, &iocs);

    Ok(Report {
        schema_version: 1,
        subject: message
            .subject()
            .map(|value| truncate(value.to_string(), MAX_VALUE_BYTES, &mut truncated)),
        from: addresses(message.from()),
        to: addresses(message.to()),
        reply_to: addresses(message.reply_to()),
        headers,
        attachments,
        bodies,
        iocs,
        signals,
        truncated,
        warnings,
    })
}

fn addresses(value: Option<&ParsedAddress<'_>>) -> Vec<Address> {
    match value {
        Some(ParsedAddress::List(addresses)) => addresses.iter().filter_map(address).collect(),
        Some(ParsedAddress::Group(groups)) => groups
            .iter()
            .flat_map(|group| group.addresses.iter())
            .filter_map(address)
            .collect(),
        _ => Vec::new(),
    }
}

fn header_value_text(value: &HeaderValue<'_>) -> String {
    value
        .as_text()
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("{value:?}"))
}

fn address(item: &Addr<'_>) -> Option<Address> {
    Some(Address {
        name: item.name.as_ref().map(ToString::to_string),
        address: item.address.as_ref()?.to_string(),
    })
}

fn collect_scan_text(
    bytes: &[u8],
    headers: &[Header],
    bodies: &[Body],
    attachments: &[Attachment],
    include_attachment_data: bool,
) -> String {
    let mut text = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_TEXT_BYTES)]).into_owned();
    headers.iter().for_each(|header| {
        text.push('\n');
        text.push_str(&header.value);
    });
    bodies.iter().for_each(|body| {
        text.push('\n');
        text.push_str(&body.value);
    });
    if include_attachment_data {
        attachments.iter().for_each(|attachment| {
            if let Some(name) = &attachment.name {
                text.push('\n');
                text.push_str(name);
            }
        });
    }
    text.truncate(MAX_TEXT_BYTES);
    text
}

fn extract_iocs(text: &str, max_iocs: usize, truncated: &mut bool) -> Vec<Ioc> {
    let mut values = BTreeSet::new();
    text.split(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                '<' | '>' | '"' | '\'' | '(' | ')' | '[' | ']' | ',' | ';'
            )
    })
    .map(|value| value.trim_matches(|character: char| ".:/?=&".contains(character)))
    .filter(|value| !value.is_empty() && value.len() <= MAX_VALUE_BYTES)
    .for_each(|value| {
        let kind = if value.starts_with("http://") || value.starts_with("https://") {
            Some("url")
        } else if value.contains('@') && value.split('@').count() == 2 {
            Some("email")
        } else if is_ipv4(value) {
            Some("ipv4")
        } else if is_hash(value) {
            Some("hash")
        } else {
            None
        };
        if let Some(kind) = kind {
            values.insert(Ioc {
                kind: kind.to_string(),
                value: value.to_string(),
            });
        }
    });
    let mut result = values.into_iter().collect::<Vec<_>>();
    if result.len() > max_iocs {
        result.truncate(max_iocs);
        *truncated = true;
    }
    result
}

fn score_signals(headers: &[Header], iocs: &[Ioc]) -> Vec<Signal> {
    let names = headers
        .iter()
        .map(|header| header.name.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let mut signals = Vec::new();
    if !names.contains("date") {
        signals.push(Signal {
            code: "missing_date".to_string(),
            severity: "low".to_string(),
            detail: "Message has no Date header".to_string(),
        });
    }
    if !names.contains("message-id") {
        signals.push(Signal {
            code: "missing_message_id".to_string(),
            severity: "low".to_string(),
            detail: "Message has no Message-ID header".to_string(),
        });
    }
    if names.contains("reply-to") && names.contains("from") {
        signals.push(Signal {
            code: "reply_to_present".to_string(),
            severity: "info".to_string(),
            detail: "Review Reply-To alignment with From".to_string(),
        });
    }
    if headers.iter().any(|header| {
        header.name.eq_ignore_ascii_case("authentication-results")
            && header.value.contains("dmarc=fail")
    }) {
        signals.push(Signal {
            code: "dmarc_fail_advertised".to_string(),
            severity: "high".to_string(),
            detail: "Authentication-Results advertises DMARC failure".to_string(),
        });
    }
    if headers.iter().any(|header| {
        header.name.eq_ignore_ascii_case("authentication-results")
            && header.value.contains("dkim=fail")
    }) {
        signals.push(Signal {
            code: "dkim_fail_advertised".to_string(),
            severity: "high".to_string(),
            detail: "Authentication-Results advertises DKIM failure".to_string(),
        });
    }
    if headers.iter().any(|header| {
        header.name.eq_ignore_ascii_case("authentication-results")
            && header.value.contains("spf=fail")
    }) {
        signals.push(Signal {
            code: "spf_fail_advertised".to_string(),
            severity: "high".to_string(),
            detail: "Authentication-Results advertises SPF failure".to_string(),
        });
    }
    if iocs.iter().any(|ioc| ioc.kind == "url") {
        signals.push(Signal {
            code: "contains_urls".to_string(),
            severity: "info".to_string(),
            detail: "Message contains one or more URLs".to_string(),
        });
    }
    signals
}

fn is_ipv4(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 4
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.parse::<u8>().is_ok())
}

fn is_hash(value: &str) -> bool {
    matches!(value.len(), 32 | 40 | 64 | 96 | 128)
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn truncate(value: String, limit: usize, truncated: &mut bool) -> String {
    if value.len() <= limit {
        return value;
    }
    *truncated = true;
    let end = value
        .char_indices()
        .take_while(|(index, _)| *index < limit)
        .last()
        .map(|(index, character)| index + character.len_utf8())
        .unwrap_or(0);
    value[..end].to_string()
}

fn error_json(error: &str) -> String {
    serde_json::json!({ "schema_version": 1, "error": error }).to_string()
}
