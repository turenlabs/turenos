/*
 * ADDITION IN THIS FORK:
 * This file provides a bridge between the Ghidra decompiler C++ logic
 * and WebAssembly exports for browser usage.
 *
 * MODIFICATION IN THIS FORK:
 * Implemented a full memory-based Architecture and Sleigh translator
 * to support real decompilation in the browser without a file system.
 */
#include "libdecomp.hh"
#include "printc.hh"
#include "loadimage_xml.hh"
#include "inject_sleigh.hh"
#include "xml_arch.hh"
#include <string>
#include <cstring>
#include <iostream>
#include <sstream>
#include <vector>

using namespace ghidra;

namespace ghidra {

/**
 * Custom Sleigh translator that loads .sla data from a memory buffer.
 */
class WasmSleigh : public Sleigh {
    const uint8_t* sla_data;
    int sla_size;
public:
    WasmSleigh(LoadImage *ld, ContextDatabase *c_db, const uint8_t* data, int size)
        : Sleigh(ld, c_db), sla_data(data), sla_size(size) {}

    virtual void initialize(DocumentStorage &store) override {
        if (!isInitialized()) {
            // Sleigh::initialize usually reads from a file path in the 'sleigh' tag.
            // We bypass that and use FormatDecode directly on our memory buffer.
            sla::FormatDecode decoder(this);
            std::string content((const char*)sla_data, sla_size);
            std::istringstream s(content, std::ios_base::binary);
            decoder.ingestStream(s);
            decode(decoder);
        } else {
            reregisterContext();
        }

        // Initialize disassembly cache (logic copied from Sleigh::initialize)
        uint4 parser_cachesize = 2;
        uint4 parser_windowsize = 32;
        if ((maxdelayslotbytes > 1) || (unique_allocatemask != 0)) {
            parser_cachesize = 8;
            parser_windowsize = 256;
        }
        discache = new DisassemblyCache(this, cache, getConstantSpace(), parser_cachesize, parser_windowsize);
    }
};

/**
 * Custom Architecture that loads PSPEC and CSPEC from strings and uses WasmSleigh.
 */
class WasmArchitecture : public SleighArchitecture {
    const uint8_t* sla_data;
    int sla_size;
    std::string pspec_content;
    std::string cspec_content;
    std::ostringstream messages;
public:
    WasmArchitecture(const std::string &fname, const std::string &targ,
                     const uint8_t* sla_ptr, int sla_sz,
                     const std::string &pspec_str, const std::string &cspec_str)
        : SleighArchitecture(fname, targ, &messages),
          sla_data(sla_ptr), sla_size(sla_sz),
          pspec_content(pspec_str), cspec_content(cspec_str) {
        errorstream = &messages; // Ensure errorstream is correctly set
    }

    virtual void buildLoader(DocumentStorage &store) override {
        const Element *el = store.getTag("binaryimage");
        if (el == (const Element *)0) {
            throw LowlevelError("Could not find binaryimage tag in DocumentStorage");
        }
        loader = new LoadImageXml(getFilename(), el);
    }

    virtual void resolveArchitecture(void) override {
        archid = loader->getArchType();
        if (archid.empty()) archid = "x86:LE:64:default";
    }

    virtual void buildSpecFile(DocumentStorage &store) override {
        std::istringstream pspec_s(pspec_content);
        Document *pdoc = store.parseDocument(pspec_s);
        store.registerTag(pdoc->getRoot());

        std::istringstream cspec_s(cspec_content);
        Document *cdoc = store.parseDocument(cspec_s);
        store.registerTag(cdoc->getRoot());

        std::istringstream s("<sleigh>mem</sleigh>");
        Document *sdoc = store.parseDocument(s);
        store.registerTag(sdoc->getRoot());
    }

    virtual Translate* buildTranslator(DocumentStorage &store) override {
        return new WasmSleigh(loader, context, sla_data, sla_size);
    }

    virtual void modifySpaces(Translate *trans) override {
    }

    virtual void postSpecFile(void) override {
        if (loader != NULL) {
            ((LoadImageXml *)loader)->open(this);
            readLoaderSymbols("::");
        }
        SleighArchitecture::postSpecFile();
    }

    virtual void printMessage(const string &message) const override {
        const_cast<std::ostringstream&>(messages) << message << std::endl;
    }

    virtual string getDescription(void) const override {
        return archid;
    }

    std::string getMessages() const { return messages.str(); }
};

} // namespace ghidra

extern "C" {

void init_decompiler() {
    startDecompilerLibrary(NULL);
}

const char* decompile_pcode(const uint8_t* sla_data, int sla_size,
                            const char* pspec_content, const char* cspec_content,
                            const char* image_xml, const char* func_name) {
    if (!sla_data || sla_size <= 0) return strdup("Error: Invalid SLA data");
    if (!image_xml) return strdup("Error: image_xml is NULL");
    if (!func_name) return strdup("Error: func_name is NULL");

    std::string result;

    try {
        DocumentStorage store;
        std::istringstream image_stream(image_xml);
        Document *doc = store.parseDocument(image_stream);
        store.registerTag(doc->getRoot());

        WasmArchitecture glb("wasm_image", "default",
                                                   sla_data, sla_size,
                                                   pspec_content ? pspec_content : "",
                                                   cspec_content ? cspec_content : "");
        glb.init(store);

        Funcdata *fd = NULL;
        fd = glb.symboltab->getGlobalScope()->queryFunction(func_name);

        if (fd == NULL) {
            try {
                Address addr = glb.parseAddressSimple(func_name);
                fd = glb.symboltab->getGlobalScope()->queryFunction(addr);
                if (fd == NULL) {
                    // Create function if not found but address is valid
                    fd = glb.symboltab->getGlobalScope()->addFunction(addr, func_name)->getFunction();
                }
            } catch (...) {}
        }

        if (fd == NULL) {
            result = "Error: Could not find or create function '" + std::string(func_name) + "'.\n";
            result += "Decompiler Messages:\n" + glb.getMessages();
        } else {
            glb.allacts.getCurrent()->reset(*fd);
            glb.allacts.getCurrent()->perform(*fd);

            std::ostringstream ss;
            glb.print->setOutputStream(&ss);
            glb.print->docFunction(fd);
            result = ss.str();

            std::string msgs = glb.getMessages();
            if (!msgs.empty()) {
                result = "/* Decompiler Messages:\n" + msgs + "*/\n" + result;
            }
        }
    } catch (LowlevelError &e) {
        result = "Lowlevel Error: " + e.explain;
    } catch (DecoderError &e) {
        result = "Decoder Error: " + e.explain;
    } catch (std::exception &e) {
        result = "Standard Exception: " + std::string(e.what());
    } catch (const char* e) {
        result = "Literal Error: " + std::string(e);
    } catch (...) {
        result = "Unknown error occurred during decompilation.";
    }

    char* cstr = (char*)malloc(result.size() + 1);
    if (cstr) std::strcpy(cstr, result.c_str());
    return cstr;
}

void free_string(char* str) {
    free(str);
}

/**
 * Helper to read multi-byte values in a WASM-safe (alignment-agnostic) way.
 */
static uint16_t read_u16_le(const uint8_t* p) { return p[0] | (p[1] << 8); }
static uint16_t read_u16_be(const uint8_t* p) { return p[1] | (p[0] << 8); }
static uint32_t read_u32_le(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24); }

/**
 * Detect the architecture of a binary based on its header (ELF/PE).
 * Returns a Ghidra language ID or an empty string if unknown.
 */
const char* detect_architecture(const uint8_t* data, int size) {
    std::string result = "";

    if (size >= 4 && data[0] == 0x7f && data[1] == 'E' && data[2] == 'L' && data[3] == 'F') {
        // ELF Detection
        if (size >= 20) {
            uint16_t machine = read_u16_le(data + 18);
            uint8_t ei_class = data[4]; // 1 = 32-bit, 2 = 64-bit
            uint8_t ei_data = data[5];  // 1 = little endian, 2 = big endian

            if (ei_data == 2) machine = read_u16_be(data + 18);

            if (machine == 0x3e) result = "x86:LE:64:default"; // x86-64
            else if (machine == 0x03) result = "x86:LE:32:default"; // x86
            else if (machine == 0x28) result = (ei_data == 1) ? "ARM:LE:32:v8" : "ARM:BE:32:v8";
            else if (machine == 0xb7) result = (ei_data == 1) ? "AARCH64:LE:64:v8A" : "AARCH64:BE:64:v8A";
            else if (machine == 0x14) result = "PowerPC:BE:32:default";
            else if (machine == 0x15) result = "PowerPC:BE:64:default";
            else if (machine == 0xf3) result = (ei_class == 2) ? "RISCV:LE:64:default" : "RISCV:LE:32:default";
        }
    } else if (size >= 2 && data[0] == 'M' && data[1] == 'Z') {
        // PE Detection
        if (size >= 0x40) {
            uint32_t pe_offset = read_u32_le(data + 0x3c);
            if ((uint64_t)pe_offset + 24 <= (uint64_t)size) {
                if (data[pe_offset] == 'P' && data[pe_offset+1] == 'E') {
                    uint16_t machine = read_u16_le(data + pe_offset + 4);
                    if (machine == 0x8664) result = "x86:LE:64:default";
                    else if (machine == 0x014c) result = "x86:LE:32:default";
                    else if (machine == 0xaa64) result = "AARCH64:LE:64:v8A";
                    else if (machine == 0x01c0) result = "ARM:LE:32:v8";
                }
            }
        }
    }

    char* cstr = (char*)malloc(result.size() + 1);
    if (cstr) std::strcpy(cstr, result.c_str());
    return cstr;
}

}
