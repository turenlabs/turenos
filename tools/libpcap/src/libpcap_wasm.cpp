/*
 * Bounded offline WebAssembly wrapper for the official libpcap library.
 * Copyright (c) 2026 Turen Labs, Inc.
 */

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <pcap/pcap.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

using emscripten::val;

namespace {

constexpr size_t MAX_INPUT_BYTES = 32 * 1024 * 1024;
constexpr size_t MAX_FILTER_BYTES = 4096;
constexpr int MAX_OFFSET = 100000;
constexpr int MAX_PACKETS = 256;
constexpr int MAX_PACKET_BYTES = 4096;
constexpr uint32_t MAX_CAPTURED_PACKET = 16 * 1024 * 1024;

const std::unordered_set<std::string> FILTER_WORDS = {
    "and",       "or",       "not",      "tcp",       "udp",      "icmp",
    "icmp6",     "arp",      "rarp",     "ip",        "ip6",      "ether",
    "host",      "net",      "port",     "portrange", "src",      "dst",
    "less",      "greater",  "broadcast", "multicast", "vlan",     "mpls",
    "proto",     "protochain", "inbound", "outbound",  "ifindex",  "link",
};

bool filter_is_numeric_only(const std::string &expression) {
  if (expression.size() > MAX_FILTER_BYTES || expression.find('\0') != std::string::npos)
    return false;
  for (size_t index = 0; index < expression.size();) {
    if (!std::isalpha(static_cast<unsigned char>(expression[index]))) {
      index++;
      continue;
    }
    size_t start = index;
    while (index < expression.size() &&
           std::isalpha(static_cast<unsigned char>(expression[index])))
      index++;
    std::string word = expression.substr(start, index - start);
    std::transform(word.begin(), word.end(), word.begin(), [](unsigned char value) {
      return static_cast<char>(std::tolower(value));
    });
    if (!FILTER_WORDS.contains(word)) return false;
  }
  return true;
}

val error_result(const std::string &message) {
  val result = val::object();
  result.set("error", message);
  return result;
}

val inspect_capture(val input, std::string filter, int offset, int limit, int max_packet_bytes) {
  const size_t input_size = input["byteLength"].as<size_t>();
  if (input_size == 0 || input_size > MAX_INPUT_BYTES)
    return error_result("capture input is empty or exceeds 32 MiB");
  if (!filter_is_numeric_only(filter))
    return error_result("filter is too long or contains symbolic names");
  if (offset < 0 || offset > MAX_OFFSET) return error_result("packet offset exceeds limit");
  limit = std::clamp(limit, 1, MAX_PACKETS);
  max_packet_bytes = std::clamp(max_packet_bytes, 0, MAX_PACKET_BYTES);

  std::vector<uint8_t> backing = emscripten::convertJSArrayToNumberVector<uint8_t>(input);
  FILE *stream = fmemopen(backing.data(), backing.size(), "rb");
  if (!stream) return error_result("unable to create in-memory capture stream");

  char error[PCAP_ERRBUF_SIZE] = {};
  pcap_t *capture = pcap_fopen_offline(stream, error);
  if (!capture) {
    fclose(stream);
    return error_result(error[0] ? error : "libpcap rejected capture");
  }

  if (!filter.empty()) {
    bpf_program program{};
    if (pcap_compile(capture, &program, filter.c_str(), 1, PCAP_NETMASK_UNKNOWN) != 0) {
      std::string message = pcap_geterr(capture);
      pcap_close(capture);
      return error_result(message);
    }
    const int installed = pcap_setfilter(capture, &program);
    pcap_freecode(&program);
    if (installed != 0) {
      std::string message = pcap_geterr(capture);
      pcap_close(capture);
      return error_result(message);
    }
  }

  val packets = val::array();
  pcap_pkthdr *header = nullptr;
  const u_char *data = nullptr;
  int matched = 0;
  int returned = 0;
  bool eof = false;
  while (returned < limit) {
    int status = pcap_next_ex(capture, &header, &data);
    if (status == PCAP_ERROR_BREAK) {
      eof = true;
      break;
    }
    if (status < 0) {
      std::string message = pcap_geterr(capture);
      pcap_close(capture);
      return error_result(message);
    }
    if (status == 0) continue;
    if (header->caplen > MAX_CAPTURED_PACKET) {
      pcap_close(capture);
      return error_result("captured packet exceeds 16 MiB limit");
    }
    if (matched++ < offset) continue;

    val packet = val::object();
    packet.set("number", matched);
    packet.set("seconds", static_cast<double>(header->ts.tv_sec));
    packet.set("microseconds", static_cast<int>(header->ts.tv_usec));
    packet.set("capturedLength", static_cast<double>(header->caplen));
    packet.set("originalLength", static_cast<double>(header->len));
    const size_t copied = std::min(static_cast<size_t>(header->caplen),
                                   static_cast<size_t>(max_packet_bytes));
    val bytes = val::global("Uint8Array").new_(val(static_cast<int>(copied)));
    bytes.call<void>("set", val(emscripten::typed_memory_view(copied, data)));
    packet.set("bytes", bytes);
    packet.set("bytesTruncated", copied < header->caplen);
    packets.set(returned++, packet);
  }

  const int datalink = pcap_datalink(capture);
  const char *name = pcap_datalink_val_to_name(datalink);
  const char *description = pcap_datalink_val_to_description(datalink);
  pcap_close(capture);

  val result = val::object();
  result.set("datalink", datalink);
  result.set("datalinkName", std::string(name ? name : "UNKNOWN"));
  result.set("datalinkDescription", std::string(description ? description : ""));
  result.set("offset", offset);
  result.set("packets", packets);
  result.set("nextOffset", eof ? val::null() : val(offset + returned));
  result.set("eof", eof);
  return result;
}

}  // namespace

EMSCRIPTEN_BINDINGS(turen_libpcap) {
  emscripten::function("inspectCapture", &inspect_capture);
}
