use etherparse::{NetSlice, SlicedPacket, TransportSlice};
use serde::Serialize;
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_RECORDS: usize = 64;
const MAX_DNS_QUESTIONS: usize = 64;
const MAX_DNS_NAME_BYTES: usize = 255;
const MAX_TEXT_BYTES: usize = 4096;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    schema_version: u8,
    operation: &'static str,
    truncated: bool,
    warnings: Vec<String>,
    result: serde_json::Value,
}

#[wasm_bindgen]
pub fn inspect(bytes: &[u8], link_type: u32, options_json: &str) -> Result<String, JsError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(JsError::new(&format!(
            "packet size {} exceeds limit {}",
            bytes.len(),
            MAX_INPUT_BYTES
        )));
    }
    if !options_json.trim().is_empty() {
        serde_json::from_str::<serde_json::Value>(options_json)
            .map_err(|error| JsError::new(&error.to_string()))?;
    }
    let mut envelope = Envelope {
        schema_version: 1,
        operation: "protocol_inspect",
        truncated: false,
        warnings: Vec::new(),
        result: serde_json::Value::Null,
    };
    envelope.result = inspect_packet(bytes, link_type, &mut envelope);
    let output = serde_json::to_string(&envelope).map_err(|error| JsError::new(&error.to_string()))?;
    if output.len() > MAX_OUTPUT_BYTES {
        return Err(JsError::new(&format!(
            "serialized output size {} exceeds limit {}",
            output.len(),
            MAX_OUTPUT_BYTES
        )));
    }
    Ok(output)
}

fn inspect_packet(bytes: &[u8], link_type: u32, envelope: &mut Envelope) -> serde_json::Value {
    let packet = match link_type {
        1 => SlicedPacket::from_ethernet(bytes),
        101 | 228 => SlicedPacket::from_ip(bytes),
        113 => SlicedPacket::from_linux_sll(bytes),
        other => {
            envelope.warnings.push(format!("unsupported link type {other}"));
            return serde_json::json!({
                "linkType": link_type,
                "packetBytes": bytes.len(),
                "parsed": false,
                "layers": [],
            });
        }
    };
    let packet = match packet {
        Ok(packet) => packet,
        Err(error) => {
            envelope.warnings.push(format!("packet parse failed: {}", clean(&error.to_string())));
            return serde_json::json!({
                "linkType": link_type,
                "packetBytes": bytes.len(),
                "parsed": false,
                "layers": [],
            });
        }
    };
    let link = packet.link.as_ref().map(|layer| clean(&format!("{layer:?}")));
    let link_exts = packet
        .link_exts
        .iter()
        .map(|layer| clean(&format!("{layer:?}")))
        .collect::<Vec<_>>();
    let net = packet.net.as_ref().map(network_metadata);
    let transport = packet
        .transport
        .as_ref()
        .map(|layer| clean(&format!("{layer:?}")));
    let payload = packet
        .transport
        .as_ref()
        .map(|transport| match transport {
            TransportSlice::Icmpv4(slice) => slice.payload(),
            TransportSlice::Icmpv6(slice) => slice.payload(),
            TransportSlice::Igmp(slice) => slice.payload(),
            TransportSlice::Udp(slice) => slice.payload(),
            TransportSlice::Tcp(slice) => slice.payload(),
        })
        .or_else(|| packet.net.as_ref().and_then(|net| net.ip_payload_ref()).map(|payload| payload.payload))
        .unwrap_or_default();
    let ports = packet.transport.as_ref().and_then(|transport| match transport {
        TransportSlice::Udp(slice) => Some((slice.source_port(), slice.destination_port())),
        TransportSlice::Tcp(slice) => Some((slice.source_port(), slice.destination_port())),
        _ => None,
    });
    let application = inspect_application(payload, transport.as_deref(), ports, envelope);
    serde_json::json!({
        "linkType": link_type,
        "packetBytes": bytes.len(),
        "parsed": true,
        "layers": {
            "link": link,
            "linkExtensions": link_exts,
            "network": net,
            "transport": transport,
            "sourcePort": ports.map(|ports| ports.0),
            "destinationPort": ports.map(|ports| ports.1),
            "fragmented": packet.is_ip_payload_fragmented(),
            "payloadBytes": payload.len(),
        },
        "application": application,
    })
}

fn network_metadata(net: &NetSlice<'_>) -> serde_json::Value {
    match net {
        NetSlice::Ipv4(slice) => serde_json::json!({
            "version": 4,
            "source": slice.header().source_addr().to_string(),
            "destination": slice.header().destination_addr().to_string(),
            "protocol": format!("{:?}", slice.payload().ip_number),
            "fragmented": slice.is_payload_fragmented(),
        }),
        NetSlice::Ipv6(slice) => serde_json::json!({
            "version": 6,
            "source": slice.header().source_addr().to_string(),
            "destination": slice.header().destination_addr().to_string(),
            "protocol": format!("{:?}", slice.payload().ip_number),
            "fragmented": slice.is_payload_fragmented(),
        }),
        NetSlice::Arp(slice) => serde_json::json!({
            "version": "arp",
            "debug": clean(&format!("{slice:?}")),
        }),
    }
}

fn inspect_application(
    payload: &[u8],
    transport: Option<&str>,
    ports: Option<(u16, u16)>,
    envelope: &mut Envelope,
) -> serde_json::Value {
    if looks_like_tls(payload) {
        return inspect_tls(payload, envelope);
    }
    if looks_like_http(payload) {
        return inspect_http(payload);
    }
    if looks_like_dns(payload, transport, ports) {
        return inspect_dns(payload, envelope);
    }
    if payload.is_empty() {
        return serde_json::json!({ "kind": "none", "bytes": 0 });
    }
    serde_json::json!({
        "kind": "unknown",
        "bytes": payload.len(),
        "prefixHex": hex_prefix(payload),
    })
}

fn looks_like_tls(payload: &[u8]) -> bool {
    payload.len() >= 5
        && matches!(payload[0], 20..=24)
        && payload[1] == 3
        && matches!(payload[2], 0..=4)
        && u16::from_be_bytes([payload[3], payload[4]]) as usize <= payload.len().saturating_sub(5)
}

fn inspect_tls(payload: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    let mut records = Vec::new();
    let mut offset = 0usize;
    while offset.saturating_add(5) <= payload.len() && records.len() < MAX_RECORDS {
        let record_type = payload[offset];
        let version = u16::from_be_bytes([payload[offset + 1], payload[offset + 2]]);
        let length = u16::from_be_bytes([payload[offset + 3], payload[offset + 4]]) as usize;
        let body_start = offset + 5;
        let body_end = body_start.saturating_add(length);
        if body_end > payload.len() {
            envelope.truncated = true;
            envelope.warnings.push("TLS record extends beyond packet payload".into());
            break;
        }
        let body = &payload[body_start..body_end];
        let handshake = if record_type == 22 { inspect_tls_handshake(body) } else { None };
        records.push(serde_json::json!({
            "type": tls_record_name(record_type),
            "typeCode": record_type,
            "version": format!("{}.{}", version >> 8, version & 0xff),
            "length": length,
            "handshake": handshake,
            "encrypted": record_type == 23,
        }));
        offset = body_end;
    }
    if offset < payload.len() && records.len() >= MAX_RECORDS {
        envelope.truncated = true;
        envelope.warnings.push(format!("TLS record list truncated at {MAX_RECORDS}"));
    }
    serde_json::json!({
        "kind": "tls",
        "records": records,
        "bytes": payload.len(),
        "decryption": "not_attempted",
    })
}

fn inspect_tls_handshake(body: &[u8]) -> Option<serde_json::Value> {
    if body.len() < 4 {
        return None;
    }
    let handshake_type = body[0];
    let length = ((body[1] as usize) << 16) | ((body[2] as usize) << 8) | body[3] as usize;
    let complete = length <= body.len().saturating_sub(4);
    let handshake_body = body.get(4..4 + length.min(body.len().saturating_sub(4))).unwrap_or_default();
    let hello = if handshake_type == 1 || handshake_type == 2 {
        inspect_tls_hello(handshake_type, handshake_body)
    } else {
        None
    };
    Some(serde_json::json!({
        "type": tls_handshake_name(handshake_type),
        "typeCode": handshake_type,
        "length": length,
        "complete": complete,
        "hello": hello,
    }))
}

fn inspect_tls_hello(handshake_type: u8, body: &[u8]) -> Option<serde_json::Value> {
    let mut offset = 0usize;
    take_bytes(body, &mut offset, 2)?;
    take_bytes(body, &mut offset, 32)?;
    let session_length = *take_bytes(body, &mut offset, 1)?.first()? as usize;
    take_bytes(body, &mut offset, session_length)?;
    if body.len() == offset {
        return Some(serde_json::json!({ "extensions": [] }));
    }
    if handshake_type == 2 {
        take_bytes(body, &mut offset, 2)?;
        take_bytes(body, &mut offset, 1)?;
    } else {
        let cipher_length = u16::from_be_bytes([
            *body.get(offset)?,
            *body.get(offset + 1)?,
        ]) as usize;
        take_bytes(body, &mut offset, 2 + cipher_length)?;
        let compression_length = *take_bytes(body, &mut offset, 1)?.first()? as usize;
        take_bytes(body, &mut offset, compression_length)?;
    }
    let extension_length = u16::from_be_bytes([
        *body.get(offset)?,
        *body.get(offset + 1)?,
    ]) as usize;
    take_bytes(body, &mut offset, 2)?;
    let available = body.len().saturating_sub(offset);
    let extensions = take_bytes(body, &mut offset, extension_length.min(available))?;
    inspect_tls_extensions(extensions)
}

fn inspect_tls_extensions(bytes: &[u8]) -> Option<serde_json::Value> {
    let mut offset = 0usize;
    let mut extensions = Vec::new();
    let mut server_name = None;
    let mut alpn = None;
    while offset.saturating_add(4) <= bytes.len() && extensions.len() < MAX_RECORDS {
        let extension_type = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]);
        let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
        offset += 4;
        let value = take_bytes(bytes, &mut offset, length)?;
        if extension_type == 0 {
            server_name = parse_tls_server_name(value);
        } else if extension_type == 16 {
            alpn = parse_tls_alpn(value);
        }
        extensions.push(serde_json::json!({
            "type": extension_type,
            "length": length,
        }));
    }
    Some(serde_json::json!({
        "serverName": server_name,
        "alpn": alpn,
        "extensions": extensions,
    }))
}

fn parse_tls_server_name(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 5 {
        return None;
    }
    let list_length = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
    if list_length > bytes.len().saturating_sub(2) || bytes[2] != 0 {
        return None;
    }
    let name_length = u16::from_be_bytes([bytes[3], bytes[4]]) as usize;
    let name = bytes.get(5..5 + name_length.min(MAX_TEXT_BYTES))?;
    Some(clean(&String::from_utf8_lossy(name)))
}

fn parse_tls_alpn(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 3 {
        return None;
    }
    let list_length = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
    if list_length > bytes.len().saturating_sub(2) {
        return None;
    }
    let length = bytes[2] as usize;
    let value = bytes.get(3..3 + length.min(MAX_TEXT_BYTES))?;
    Some(clean(&String::from_utf8_lossy(value)))
}

fn take_bytes<'a>(bytes: &'a [u8], offset: &mut usize, length: usize) -> Option<&'a [u8]> {
    let end = offset.checked_add(length)?;
    let value = bytes.get(*offset..end)?;
    *offset = end;
    Some(value)
}

fn inspect_http(payload: &[u8]) -> serde_json::Value {
    let text = String::from_utf8_lossy(&payload[..payload.len().min(MAX_TEXT_BYTES)]);
    let line = text.lines().next().unwrap_or("");
    let response = line.starts_with("HTTP/");
    let mut fields = line.split_ascii_whitespace();
    let first = fields.next().unwrap_or("");
    let second = fields.next().unwrap_or("");
    let third = fields.next().unwrap_or("");
    let start_line = if response {
        format!("{first} {second} {third}")
    } else {
        format!("{first} {} {third}", redact_http_target(second))
    };
    serde_json::json!({
        "kind": "http",
        "direction": if response { "response" } else { "request" },
        "startLine": clean(&start_line),
        "bytes": payload.len(),
        "bodyInspected": false,
    })
}

fn redact_http_target(target: &str) -> String {
    let mut value = target.to_string();
    if let Some(scheme_end) = value.find("://") {
        if let Some(user_end) = value[scheme_end + 3..].find('@') {
            let user_end = scheme_end + 3 + user_end;
            value.replace_range(scheme_end + 3..user_end, "[redacted]");
        }
    }
    if let Some(query_start) = value.find('?') {
        value.truncate(query_start);
        value.push_str("?[redacted]");
    }
    if let Some(fragment_start) = value.find('#') {
        value.truncate(fragment_start);
        value.push_str("#[redacted]");
    }
    clean(&value)
}

fn looks_like_http(payload: &[u8]) -> bool {
    const METHODS: [&[u8]; 8] = [b"GET ", b"POST ", b"PUT ", b"HEAD ", b"PATCH ", b"DELETE ", b"OPTIONS ", b"CONNECT "];
    payload.starts_with(b"HTTP/") || METHODS.iter().any(|method| payload.starts_with(method))
}

fn looks_like_dns(payload: &[u8], transport: Option<&str>, ports: Option<(u16, u16)>) -> bool {
    if payload.len() < 12 {
        return false;
    }
    let transport = transport.unwrap_or_default().to_ascii_lowercase();
    let dns_port = ports.is_some_and(|(source, destination)| source == 53 || destination == 53);
    dns_port && (transport.contains("udp") || transport.contains("tcp"))
}

fn inspect_dns(payload: &[u8], envelope: &mut Envelope) -> serde_json::Value {
    let flags = u16::from_be_bytes([payload[2], payload[3]]);
    let questions = u16::from_be_bytes([payload[4], payload[5]]) as usize;
    let answers = u16::from_be_bytes([payload[6], payload[7]]) as usize;
    let authorities = u16::from_be_bytes([payload[8], payload[9]]) as usize;
    let additionals = u16::from_be_bytes([payload[10], payload[11]]) as usize;
    let mut offset = 12usize;
    let mut names = Vec::new();
    for _ in 0..questions.min(MAX_DNS_QUESTIONS) {
        let Some((name, next)) = read_dns_name(payload, offset, envelope) else {
            break;
        };
        offset = next;
        if offset.saturating_add(4) > payload.len() {
            envelope.warnings.push("DNS question is truncated".into());
            break;
        }
        let record_type = u16::from_be_bytes([payload[offset], payload[offset + 1]]);
        let class = u16::from_be_bytes([payload[offset + 2], payload[offset + 3]]);
        offset += 4;
        names.push(serde_json::json!({ "name": name, "type": record_type, "class": class }));
    }
    if questions > MAX_DNS_QUESTIONS {
        envelope.truncated = true;
    }
    serde_json::json!({
        "kind": "dns",
        "transactionId": u16::from_be_bytes([payload[0], payload[1]]),
        "response": flags & 0x8000 != 0,
        "recursionDesired": flags & 0x0100 != 0,
        "recursionAvailable": flags & 0x0080 != 0,
        "counts": { "questions": questions, "answers": answers, "authorities": authorities, "additionals": additionals },
        "questions": names,
    })
}

fn read_dns_name(payload: &[u8], start: usize, envelope: &mut Envelope) -> Option<(String, usize)> {
    let mut offset = start;
    let mut consumed = start;
    let mut labels = Vec::new();
    let mut jumped = false;
    for _ in 0..128 {
        if offset >= payload.len() {
            envelope.warnings.push("DNS name is truncated".into());
            return None;
        }
        let length = payload[offset];
        if length == 0 {
            if !jumped {
                consumed = offset + 1;
            }
            return Some((labels.join("."), consumed));
        }
        if length & 0xc0 == 0xc0 {
            if offset + 1 >= payload.len() {
                envelope.warnings.push("DNS compression pointer is truncated".into());
                return None;
            }
            let pointer = (((length as usize & 0x3f) << 8) | payload[offset + 1] as usize) as usize;
            if pointer >= payload.len() || pointer == offset {
                envelope.warnings.push("DNS compression pointer is invalid".into());
                return None;
            }
            if !jumped {
                consumed = offset + 2;
                jumped = true;
            }
            offset = pointer;
            continue;
        }
        if length > 63 || offset.saturating_add(1 + length as usize) > payload.len() {
            envelope.warnings.push("DNS label is invalid or truncated".into());
            return None;
        }
        let label = &payload[offset + 1..offset + 1 + length as usize];
        if labels.iter().map(String::len).sum::<usize>() + labels.len() + label.len() > MAX_DNS_NAME_BYTES {
            envelope.warnings.push("DNS name exceeds limit".into());
            return None;
        }
        labels.push(clean(&String::from_utf8_lossy(label)));
        offset += 1 + length as usize;
    }
    envelope.warnings.push("DNS compression pointer depth exceeded".into());
    None
}

fn tls_record_name(value: u8) -> &'static str {
    match value {
        20 => "change_cipher_spec",
        21 => "alert",
        22 => "handshake",
        23 => "application_data",
        24 => "heartbeat",
        _ => "unknown",
    }
}

fn tls_handshake_name(value: u8) -> &'static str {
    match value {
        1 => "client_hello",
        2 => "server_hello",
        11 => "certificate",
        12 => "server_key_exchange",
        13 => "certificate_request",
        14 => "server_hello_done",
        16 => "client_key_exchange",
        20 => "finished",
        _ => "unknown",
    }
}

fn hex_prefix(bytes: &[u8]) -> String {
    let length = bytes.len().min(32);
    let mut output = String::with_capacity(length * 2);
    for byte in &bytes[..length] {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn clean(value: &str) -> String {
    value.chars().take(MAX_TEXT_BYTES).collect()
}
