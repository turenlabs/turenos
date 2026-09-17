use ieee80211::data_frame::DataFrame;
use ieee80211::mgmt_frame::{BeaconFrame, DeauthenticationFrame};
use ieee80211::GenericFrame;
use pcap_file::pcap::PcapParser;
use pcap_file::DataLink;
use radiotap::Radiotap;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_PACKETS: usize = 4096;
const MAX_NETWORKS: usize = 256;
const MAX_CLIENTS: usize = 1024;
const MAX_EVENTS: usize = 256;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    schema_version: u8,
    truncated: bool,
    warnings: Vec<String>,
    result: serde_json::Value,
}

struct Network {
    bssid: String,
    ssid: Option<String>,
    beacons: u32,
    channel_mhz: Option<u16>,
    signal_dbm: Option<i8>,
}

#[wasm_bindgen]
pub fn analyze(bytes: &[u8], options_json: &str) -> Result<String, JsError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(JsError::new(&format!("input size {} exceeds limit {}", bytes.len(), MAX_INPUT_BYTES)));
    }
    let options: serde_json::Value = if options_json.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(options_json).map_err(|error| JsError::new(&error.to_string()))?
    };
    let mut envelope = Envelope {
        schema_version: 1,
        truncated: false,
        warnings: Vec::new(),
        result: serde_json::Value::Null,
    };
    envelope.result = summarize(bytes, &options, &mut envelope);
    let json = serde_json::to_string(&envelope).map_err(|error| JsError::new(&error.to_string()))?;
    if json.len() > MAX_OUTPUT_BYTES {
        return Err(JsError::new(&format!("serialized output size {} exceeds limit {}", json.len(), MAX_OUTPUT_BYTES)));
    }
    Ok(json)
}

fn summarize(bytes: &[u8], options: &serde_json::Value, envelope: &mut Envelope) -> serde_json::Value {
    let max_packets = options
        .get("maxPackets")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1024)
        .min(MAX_PACKETS as u64) as usize;
    match PcapParser::new(bytes) {
        Ok((remaining, parser)) => summarize_pcap(remaining, parser, max_packets, envelope),
        Err(_) => {
            envelope.warnings.push("input is not a PCAP; decoded as a single 802.11 or radiotap frame".into());
            let mut networks = BTreeMap::new();
            let mut clients = BTreeSet::new();
            let mut events = Vec::new();
            let mut eapol = 0usize;
            let mut deauth = 0usize;
            inspect_packet(bytes, Radiotap::from_bytes(bytes).is_ok(), 0.0, &mut networks, &mut clients, &mut events, &mut eapol, &mut deauth, envelope);
            report(networks, clients, events, 1, "frame", deauth, eapol, envelope)
        }
    }
}

fn summarize_pcap(mut rest: &[u8], parser: PcapParser, max_packets: usize, envelope: &mut Envelope) -> serde_json::Value {
    let datalink = parser.header().datalink;
    let radiotap = matches!(datalink, DataLink::IEEE802_11_RADIOTAP);
    let wifi = radiotap || matches!(datalink, DataLink::IEEE802_11 | DataLink::IEEE802_11_PRISM | DataLink::IEEE802_11_AVS);
    if !wifi {
        envelope.warnings.push(format!("datalink {datalink:?} is not 802.11; frames were not decoded"));
    }
    let mut networks = BTreeMap::new();
    let mut clients = BTreeSet::new();
    let mut events = Vec::new();
    let mut packet_count = 0usize;
    let mut eapol = 0usize;
    let mut deauth = 0usize;
    while packet_count < max_packets {
        match parser.next_packet(rest) {
            Ok((next, packet)) => {
                packet_count += 1;
                if wifi {
                    inspect_packet(packet.data(), radiotap, packet.timestamp().as_secs_f64(), &mut networks, &mut clients, &mut events, &mut eapol, &mut deauth, envelope);
                }
                rest = next;
            }
            Err(_) => break,
        }
    }
    if !rest.is_empty() && packet_count >= max_packets {
        envelope.truncated = true;
    }
    report(networks, clients, events, packet_count, &format!("{datalink:?}"), deauth, eapol, envelope)
}

fn report(
    mut networks: BTreeMap<String, Network>,
    mut clients: BTreeSet<String>,
    mut events: Vec<serde_json::Value>,
    packet_count: usize,
    datalink: &str,
    deauth: usize,
    eapol: usize,
    envelope: &mut Envelope,
) -> serde_json::Value {
    if networks.len() > MAX_NETWORKS {
        envelope.truncated = true;
        networks = networks.into_iter().take(MAX_NETWORKS).collect();
    }
    if clients.len() > MAX_CLIENTS {
        envelope.truncated = true;
        clients = clients.into_iter().take(MAX_CLIENTS).collect();
    }
    if events.len() > MAX_EVENTS {
        envelope.truncated = true;
        events.truncate(MAX_EVENTS);
    }
    serde_json::json!({
        "datalink": datalink,
        "packetCount": packet_count,
        "networks": networks.values().map(|network| serde_json::json!({
            "bssid": network.bssid,
            "ssid": network.ssid,
            "beacons": network.beacons,
            "channelMhz": network.channel_mhz,
            "signalDbm": network.signal_dbm,
        })).collect::<Vec<_>>(),
        "clients": clients.into_iter().collect::<Vec<_>>(),
        "deauthCount": deauth,
        "eapolCount": eapol,
        "handshakePresent": eapol >= 2,
        "notableEvents": events,
    })
}

fn inspect_packet(
    data: &[u8],
    radiotap: bool,
    timestamp: f64,
    networks: &mut BTreeMap<String, Network>,
    clients: &mut BTreeSet<String>,
    events: &mut Vec<serde_json::Value>,
    eapol: &mut usize,
    deauth: &mut usize,
    envelope: &mut Envelope,
) {
    let (frame_bytes, channel_mhz, signal_dbm) = if radiotap {
        match Radiotap::from_bytes(data) {
            Ok(header) => {
                let skip = header.header.length as usize;
                if skip >= data.len() {
                    envelope.warnings.push("radiotap header longer than packet".into());
                    return;
                }
                (
                    &data[skip..],
                    header.channel.as_ref().map(|channel| channel.freq),
                    header.antenna_signal.as_ref().map(|signal| signal.value),
                )
            }
            Err(error) => {
                envelope.warnings.push(error.to_string());
                return;
            }
        }
    } else {
        (data, None, None)
    };
    inspect_frame(frame_bytes, timestamp, channel_mhz, signal_dbm, networks, clients, events, eapol, deauth);
}

fn inspect_frame(
    bytes: &[u8],
    timestamp: f64,
    channel_mhz: Option<u16>,
    signal_dbm: Option<i8>,
    networks: &mut BTreeMap<String, Network>,
    clients: &mut BTreeSet<String>,
    events: &mut Vec<serde_json::Value>,
    eapol: &mut usize,
    deauth: &mut usize,
) {
    let Ok(generic) = GenericFrame::new(bytes, false) else {
        return;
    };
    if let Some(addr) = generic.address_2() {
        clients.insert(format!("{addr}"));
    }
    if let Some(Ok(beacon)) = generic.parse_to_typed::<BeaconFrame>() {
        let bssid = format!("{}", beacon.header.bssid);
        let ssid = beacon.body.ssid().map(str::to_string);
        let network = networks.entry(bssid.clone()).or_insert_with(|| Network {
            bssid: bssid.clone(),
            ssid: ssid.clone(),
            beacons: 0,
            channel_mhz,
            signal_dbm,
        });
        network.beacons += 1;
        if network.ssid.is_none() {
            network.ssid = ssid.clone();
        }
        if network.channel_mhz.is_none() {
            network.channel_mhz = channel_mhz;
        }
        if let Some(signal) = signal_dbm {
            network.signal_dbm = Some(signal);
        }
        if events.len() < MAX_EVENTS && network.beacons == 1 {
            events.push(serde_json::json!({
                "kind": "beacon",
                "timestamp": timestamp,
                "bssid": bssid,
                "ssid": ssid,
                "channelMhz": channel_mhz,
            }));
        }
        return;
    }
    if let Some(Ok(frame)) = generic.parse_to_typed::<DeauthenticationFrame>() {
        *deauth += 1;
        if events.len() < MAX_EVENTS {
            events.push(serde_json::json!({
                "kind": "deauth",
                "timestamp": timestamp,
                "transmitter": format!("{}", frame.header.transmitter_address),
                "receiver": format!("{}", frame.header.receiver_address),
                "bssid": format!("{}", frame.header.bssid),
            }));
        }
        return;
    }
    if generic.is_eapol_key_frame() {
        *eapol += 1;
        if events.len() < MAX_EVENTS {
            let length = generic
                .parse_to_typed::<DataFrame>()
                .and_then(Result::ok)
                .and_then(|frame| frame.payload)
                .map(|payload| payload.len())
                .unwrap_or(0);
            events.push(serde_json::json!({
                "kind": "eapol",
                "timestamp": timestamp,
                "length": length,
            }));
        }
    }
}
