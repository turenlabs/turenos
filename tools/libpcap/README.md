# Official libpcap Offline WASM

Source-pinned WebAssembly build of tcpdump-group libpcap 1.10.6 for bounded,
memory-backed offline PCAP and PCAPNG reading.

The build selects `PCAP_TYPE=null`, excludes optional capture backends and
remote capture, and exports no device, path, dump, callback, handle or live
capture API. Filters are limited to numeric BPF expressions so name-service
lookups cannot cross the runtime boundary.
