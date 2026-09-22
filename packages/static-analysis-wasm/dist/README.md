# Static Analysis WASM

Bounded WebAssembly operations for offline file identification, hashing,
disassembly, archive listing, document parsing, and overlay inspection.

The wrapper accepts bytes plus a typed operation name and returns versioned
JSON. It does not read host paths, execute analyzed code, or write extracted
archive members to disk.

```text
identify_file          hash_digest           entropy_scan
fuzzy_hash             import_hash           disassemble
scan_embedded          detect_packer         list_archive
extract_archive_entry  parse_pdf             parse_ole
office_inspect
parse_exif             parse_certificate     parse_plist
parse_lnk              parse_minidump        demangle_symbol
parse_dotnet           inspect_overlay
```
