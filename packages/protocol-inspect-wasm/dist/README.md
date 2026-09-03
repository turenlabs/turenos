# Protocol Inspect WASM

Bounded WebAssembly inspection for one offline packet selected from a PCAP or
PCAPNG capture. The packet is parsed from caller-supplied bytes with
`etherparse`; no sockets, live capture, DNS, decryption, or host filesystem
access are available.

The public ABI is:

```text
inspect(packetBytes, linkType, optionsJson) -> JSON
```

Supported link types are Ethernet II (`1`), raw IP (`101` and `228`), and
Linux cooked capture v1 (`113`). The result reports parsed link/network/
transport layers and bounded passive summaries for DNS, HTTP, and TLS record
headers. TLS application data is never decrypted and payload bytes are not
returned beyond a short unknown-protocol prefix.
