use std::{
    cell::RefCell,
    collections::HashMap,
    hash::Hash,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Arc,
};

use futures::executor::block_on;
use mail_auth::{
    AuthenticatedMessage, DmarcResult, DnsError, DnssecStatus, Error, MX, MessageAuthenticator,
    Parameters, RecordSet, ResolverCache, Txt,
    common::{parse::TxtRecordParser, verify::DomainKey},
    dmarc::{Dmarc, verify::DmarcParameters},
    spf::{Spf, verify::SpfParameters},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 24 * 1024 * 1024;
const MAX_DNS_ENTRIES: usize = 4096;
const MAX_TXT_BYTES: usize = 256 * 1024;
const MAX_OUTPUT_BYTES: usize = 512 * 1024;

#[derive(Debug, Deserialize)]
struct Request {
    schema_version: u32,
    envelope: Envelope,
    receiver_domain: String,
    evaluation_time_unix: u64,
    dns_snapshot: DnsSnapshot,
}

#[derive(Debug, Deserialize)]
struct Envelope {
    client_ip: String,
    helo: String,
    mail_from: String,
}

#[derive(Debug, Deserialize)]
struct DnsSnapshot {
    schema_version: u32,
    captured_at_unix: u64,
    entries: Vec<DnsEntry>,
}

#[derive(Debug, Deserialize)]
struct DnsEntry {
    name: String,
    #[serde(rename = "type")]
    record_type: String,
    rcode: String,
    ttl_seconds: u32,
    dnssec: Option<String>,
    txt: Option<Vec<String>>,
    mx: Option<Vec<MxEntry>>,
    addresses: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct MxEntry {
    preference: u16,
    exchange: String,
}

struct Cache<K, V> {
    values: RefCell<HashMap<K, V>>,
}

impl<K, V> Default for Cache<K, V> {
    fn default() -> Self {
        Self {
            values: RefCell::new(HashMap::new()),
        }
    }
}

impl<K, V> ResolverCache<K, V> for Cache<K, V>
where
    K: Eq + Hash + Clone,
    V: Clone,
{
    fn get<Q>(&self, name: &Q) -> Option<V>
    where
        K: std::borrow::Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.values.borrow().get(name).cloned()
    }

    fn remove<Q>(&self, name: &Q) -> Option<V>
    where
        K: std::borrow::Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.values.borrow_mut().remove(name)
    }

    fn insert(&self, key: K, value: V, _: web_time::Instant) {
        self.values.borrow_mut().insert(key, value);
    }
}

#[derive(Default)]
struct Caches {
    txt: Cache<Box<str>, Txt>,
    mx: Cache<Box<str>, RecordSet<MX>>,
    ipv4: Cache<Box<str>, RecordSet<Ipv4Addr>>,
    ipv6: Cache<Box<str>, RecordSet<Ipv6Addr>>,
    ptr: Cache<IpAddr, RecordSet<Box<str>>>,
}

impl Caches {
    fn parameters<'a, P>(
        &'a self,
        params: P,
    ) -> Parameters<
        'a,
        P,
        Cache<Box<str>, Txt>,
        Cache<Box<str>, RecordSet<MX>>,
        Cache<Box<str>, RecordSet<Ipv4Addr>>,
        Cache<Box<str>, RecordSet<Ipv6Addr>>,
        Cache<IpAddr, RecordSet<Box<str>>>,
    > {
        Parameters::new(params)
            .with_txt_cache(&self.txt)
            .with_mx_cache(&self.mx)
            .with_ipv4_cache(&self.ipv4)
            .with_ipv6_cache(&self.ipv6)
            .with_ptr_cache(&self.ptr)
    }
}

#[wasm_bindgen]
pub fn authenticate(bytes: &[u8], request_json: &str) -> String {
    if bytes.len() > MAX_MESSAGE_BYTES || request_json.len() > MAX_REQUEST_BYTES {
        return error_json("input_too_large");
    }
    let request = match serde_json::from_str::<Request>(request_json) {
        Ok(request) if request.schema_version == 1 && request.dns_snapshot.schema_version == 1 => {
            request
        }
        Ok(_) => return error_json("unsupported_schema"),
        Err(_) => return error_json("invalid_request"),
    };
    if request.dns_snapshot.entries.len() > MAX_DNS_ENTRIES
        || request
            .dns_snapshot
            .entries
            .iter()
            .filter_map(|entry| entry.txt.as_ref())
            .flatten()
            .map(String::len)
            .sum::<usize>()
            > MAX_TXT_BYTES
    {
        return error_json("dns_snapshot_too_large");
    }
    if request.dns_snapshot.captured_at_unix > request.evaluation_time_unix {
        return error_json("dns_snapshot_from_future");
    }
    let client_ip = match request.envelope.client_ip.parse::<IpAddr>() {
        Ok(ip) => ip,
        Err(_) => return error_json("invalid_client_ip"),
    };
    let message = match AuthenticatedMessage::parse(bytes) {
        Some(message) => message,
        None => return error_json("invalid_message"),
    };
    let caches = match build_caches(&request.dns_snapshot) {
        Ok(caches) => caches,
        Err(error) => return error_json(error),
    };
    let authenticator = MessageAuthenticator::new_offline();
    let dkim = block_on(authenticator.verify_dkim(caches.parameters(&message)));
    let spf_helo = block_on(authenticator.verify_spf(caches.parameters(
        SpfParameters::verify_ehlo(client_ip, &request.envelope.helo, &request.receiver_domain),
    )));
    let spf_mail_from = block_on(authenticator.verify_spf(caches.parameters(
        SpfParameters::verify_mail_from(
            client_ip,
            &request.envelope.helo,
            &request.receiver_domain,
            &request.envelope.mail_from,
        ),
    )));
    let mail_from_domain = request
        .envelope
        .mail_from
        .rsplit_once('@')
        .map(|(_, domain)| domain)
        .unwrap_or(request.envelope.helo.as_str());
    let dmarc = block_on(
        authenticator.verify_dmarc(caches.parameters(DmarcParameters::new(
            &message,
            &dkim,
            mail_from_domain,
            &spf_mail_from,
        ))),
    );
    let warnings = collect_warnings(&dkim, &spf_helo, &spf_mail_from, &dmarc);
    let result = serde_json::json!({
        "schema_version": 1,
        "engine": "mail-auth",
        "upstream_version": "0.12.1",
        "message_sha256": digest(bytes),
        "dns_snapshot_captured_at_unix": request.dns_snapshot.captured_at_unix,
        "complete": warnings.is_empty(),
        "truncated": false,
        "dkim": dkim.iter().map(|output| serde_json::json!({
            "result": output.result().to_string(),
            "domain": output.signature().map(|signature| signature.d.clone()),
            "selector": output.signature().map(|signature| signature.s.clone()),
        })).collect::<Vec<_>>(),
        "spf_helo": { "result": spf_helo.result().to_string(), "domain": spf_helo.domain() },
        "spf_mail_from": { "result": spf_mail_from.result().to_string(), "domain": spf_mail_from.domain() },
        "dmarc": {
            "result": dmarc_result(dmarc.dkim_result(), dmarc.spf_result()),
            "domain": dmarc.domain(),
            "policy": format!("{:?}", dmarc.policy()),
            "dkim": dmarc.dkim_result().to_string(),
            "spf": dmarc.spf_result().to_string(),
        },
        "warnings": warnings,
    }).to_string();
    if result.len() > MAX_OUTPUT_BYTES {
        return error_json("output_too_large");
    }
    result
}

fn build_caches(snapshot: &DnsSnapshot) -> Result<Caches, &'static str> {
    let caches = Caches::default();
    for entry in &snapshot.entries {
        let name = canonical_name(&entry.name).ok_or("invalid_dns_name")?;
        if entry.ttl_seconds > 604_800 || entry.dnssec.as_deref() == Some("BOGUS") {
            continue;
        }
        if entry.record_type.eq_ignore_ascii_case("TXT") {
            let error = match entry.rcode.as_str() {
                "NOERROR" if entry.txt.as_ref().is_some_and(Vec::is_empty) => {
                    Some(Error::Dns(DnsError::RecordNotFound(0)))
                }
                "NXDOMAIN" => Some(Error::Dns(DnsError::RecordNotFound(3))),
                "SERVFAIL" | "REFUSED" => Some(Error::Dns(DnsError::Resolver(format!(
                    "offline_snapshot_rcode:{}",
                    entry.rcode
                )))),
                "NOERROR" => None,
                _ => return Err("invalid_dns_rcode"),
            };
            if let Some(error) = error {
                caches
                    .txt
                    .insert(name, Txt::Error(error), web_time::Instant::now());
                continue;
            }
        } else if entry.rcode != "NOERROR" {
            continue;
        }
        match entry.record_type.to_ascii_uppercase().as_str() {
            "TXT" => {
                let value = entry.txt.as_ref().ok_or("invalid_txt_record")?.concat();
                let parsed = Spf::parse(value.as_bytes())
                    .map(|value| Txt::Spf(Arc::new(value)))
                    .or_else(|_| {
                        Dmarc::parse(value.as_bytes()).map(|value| Txt::Dmarc(Arc::new(value)))
                    })
                    .or_else(|_| {
                        DomainKey::parse(value.as_bytes())
                            .map(|value| Txt::DomainKey(Arc::new(value)))
                    })
                    .map_err(|_| "unsupported_txt_record")?;
                caches.txt.insert(name, parsed, web_time::Instant::now());
            }
            "MX" => {
                let records = entry.mx.as_ref().ok_or("invalid_mx_record")?;
                let mut grouped = Vec::<(u16, Vec<Box<str>>)>::new();
                for record in records {
                    let exchange = canonical_name(&record.exchange).ok_or("invalid_mx_name")?;
                    if let Some((_, exchanges)) = grouped
                        .iter_mut()
                        .find(|(preference, _)| *preference == record.preference)
                    {
                        exchanges.push(exchange);
                    } else {
                        grouped.push((record.preference, vec![exchange]));
                    }
                }
                let rrset = grouped
                    .into_iter()
                    .map(|(preference, exchanges)| MX {
                        preference,
                        exchanges: exchanges.into_boxed_slice(),
                    })
                    .collect::<Vec<_>>()
                    .into();
                caches.mx.insert(
                    name,
                    RecordSet {
                        rrset,
                        dnssec_status: DnssecStatus::Indeterminate,
                    },
                    web_time::Instant::now(),
                );
            }
            "A" => {
                let addresses = entry.addresses.as_ref().ok_or("invalid_a_record")?;
                let rrset = addresses
                    .iter()
                    .map(|address| {
                        address
                            .parse::<Ipv4Addr>()
                            .map_err(|_| "invalid_ipv4_address")
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .into();
                caches.ipv4.insert(
                    name,
                    RecordSet {
                        rrset,
                        dnssec_status: DnssecStatus::Indeterminate,
                    },
                    web_time::Instant::now(),
                );
            }
            "AAAA" => {
                let addresses = entry.addresses.as_ref().ok_or("invalid_aaaa_record")?;
                let rrset = addresses
                    .iter()
                    .map(|address| {
                        address
                            .parse::<Ipv6Addr>()
                            .map_err(|_| "invalid_ipv6_address")
                    })
                    .collect::<Result<Vec<_>, _>>()?
                    .into();
                caches.ipv6.insert(
                    name,
                    RecordSet {
                        rrset,
                        dnssec_status: DnssecStatus::Indeterminate,
                    },
                    web_time::Instant::now(),
                );
            }
            "PTR" => {}
            _ => return Err("unsupported_dns_record_type"),
        }
    }
    Ok(caches)
}

fn canonical_name(name: &str) -> Option<Box<str>> {
    let name = name.trim().trim_end_matches('.');
    if name.is_empty()
        || name.len() > 253
        || name
            .bytes()
            .any(|byte| byte == b'\r' || byte == b'\n' || byte == 0)
    {
        return None;
    }
    Some(format!("{name}.").to_ascii_lowercase().into_boxed_str())
}

fn collect_warnings<T: std::fmt::Debug>(
    dkim: &[T],
    spf_helo: &mail_auth::SpfOutput,
    spf_mail_from: &mail_auth::SpfOutput,
    dmarc: &mail_auth::DmarcOutput,
) -> Vec<String> {
    let mut warnings = Vec::new();
    if format!("{dkim:?}{spf_helo:?}{spf_mail_from:?}{dmarc:?}").contains("offline_snapshot_miss") {
        warnings.push("offline_snapshot_miss".to_string());
    }
    warnings
}

fn dmarc_result(dkim: &DmarcResult, spf: &DmarcResult) -> String {
    if matches!(dkim, DmarcResult::Pass) || matches!(spf, DmarcResult::Pass) {
        return "pass".to_string();
    }
    if matches!(dkim, DmarcResult::Fail(_) | DmarcResult::PermError(_))
        || matches!(spf, DmarcResult::Fail(_) | DmarcResult::PermError(_))
    {
        return "fail".to_string();
    }
    if matches!(dkim, DmarcResult::TempError(_)) || matches!(spf, DmarcResult::TempError(_)) {
        return "temp-error".to_string();
    }
    "none".to_string()
}

fn digest(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn error_json(error: &str) -> String {
    serde_json::json!({ "schema_version": 1, "complete": false, "error": error }).to_string()
}

#[cfg(test)]
mod tests {
    use super::authenticate;

    #[test]
    fn verifies_snapshot_backed_spf_and_dmarc() {
        let message = b"From: Alice <alice@example.test>\r\nTo: Bob <bob@example.test>\r\nDate: Sat, 29 Aug 2026 12:00:00 +0000\r\nMessage-ID: <auth@example.test>\r\nSubject: Authentication fixture\r\n\r\nfixture";
        let request = r#"{"schema_version":1,"envelope":{"client_ip":"203.0.113.7","helo":"mail.example.test","mail_from":"alice@example.test"},"receiver_domain":"mx.receiver.test","evaluation_time_unix":1788000000,"dns_snapshot":{"schema_version":1,"captured_at_unix":1787996400,"entries":[{"name":"mail.example.test.","type":"TXT","rcode":"NOERROR","ttl_seconds":3600,"txt":["v=spf1 ip4:203.0.113.7 -all"]},{"name":"example.test.","type":"TXT","rcode":"NOERROR","ttl_seconds":3600,"txt":["v=spf1 ip4:203.0.113.7 -all"]},{"name":"_dmarc.example.test.","type":"TXT","rcode":"NOERROR","ttl_seconds":3600,"txt":["v=DMARC1; p=reject"]},{"name":"_dmarc.test.","type":"TXT","rcode":"NOERROR","ttl_seconds":3600,"txt":[]}]}}"#;
        let result = authenticate(message, request);
        assert!(result.contains("\"complete\":true"), "{result}");
        assert!(result.contains("\"result\":\"Pass\""), "{result}");
    }
}
