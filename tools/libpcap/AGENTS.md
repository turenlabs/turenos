# libpcap target

Rules for `tools/libpcap`, on top of the shared rules in `tools/AGENTS.md`.

- Build official tcpdump-group libpcap 1.10.6 at commit
  `a999701dca5c873779281938baee6bc185a8d4dc` with `PCAP_TYPE=null`.
- Expose only memory-backed offline reading and numeric classic BPF filters.
- Do not expose live capture, devices, paths, dumping, callbacks, handles,
  remote capture, or symbolic name-service lookups.
