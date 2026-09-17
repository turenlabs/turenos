/* Memory-backed WebAssembly bridge for monodis.
 *
 * Narrow ABI (no CLI, no paths, no threads, no network):
 *
 *   void  init_monodis(void);
 *   char *monodis_disassemble(bytes_ptr, len, options_json_ptr);
 *   void  free_string(char *);
 *
 * Design notes:
 * - mono/dis/main.c IS compiled (main renamed to monodis_main via
 *   -Dmain=monodis_main; see Makefile.wasm). The bridge drives the real
 *   disassemble_file() from patches/0001-expose-disassemble-file.patch,
 *   so output is byte-identical to native monodis for the same input.
 * - Input bytes are staged through MEMFS (/tmp/monodis-input.dll, never
 *   the host filesystem) so the unmodified mono_image_open() path runs.
 * - The FILE *output global is captured with open_memstream and truncated
 *   at 4 MiB. Assembly preload/search hooks resolve nothing: only the
 *   supplied bytes are read, never corlib or referenced assemblies.
 * - Input is capped at 32 MiB. Failures return a short "Error: ..." string.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <glib.h>

#include <mono/metadata/appdomain.h>
#include <mono/metadata/assembly-internals.h>
#include <mono/metadata/image.h>
#include <mono/metadata/w32handle.h>
#include <mono/utils/mono-counters.h>
#include <mono/utils/mono-threads.h>
#include <mono/utils/mono-tls.h>

#include "dump.h"
#include "get.h"

#define MONODIS_MAX_INPUT (32u * 1024u * 1024u)
#define MONODIS_MAX_OUTPUT (4u * 1024u * 1024u)
#define MONODIS_MEMFS_PATH "/tmp/monodis-input.dll"

/* Owned by mono/dis/main.c (compiled with -Dmain=monodis_main). */
int disassemble_file (const char *file);
extern FILE *output;
extern int dump_table;
extern gboolean dump_header_data_p;
extern gboolean dump_forward_decls;
extern gboolean substitute_with_mscorlib_p;
extern gboolean dump_managed_resources;
extern struct {
	const char *name;
	int table;
	void (*dumper) (MonoImage *m);
} table_list [];

static int initialized;

/* Assembly resolution hooks: resolve nothing. Referenced assemblies and
 * corlib are never loaded; only the staged input bytes are read. */
static MonoAssembly *
wasm_preload_hook (MonoAssemblyLoadContext *alc, MonoAssemblyName *aname,
		   char **assemblies_path, gboolean refonly,
		   gpointer user_data, MonoError *error)
{
	(void) alc;
	(void) aname;
	(void) assemblies_path;
	(void) refonly;
	(void) user_data;
	(void) error;
	return NULL;
}

static MonoAssembly *
wasm_search_hook (MonoAssemblyLoadContext *alc, MonoAssembly *requesting,
		  MonoAssemblyName *aname, gboolean refonly, gboolean postload,
		  gpointer user_data, MonoError *error)
{
	(void) alc;
	(void) requesting;
	(void) aname;
	(void) refonly;
	(void) postload;
	(void) user_data;
	(void) error;
	return NULL;
}

static void
wasm_load_hook (MonoAssemblyLoadContext *alc, MonoAssembly *assembly,
		gpointer user_data, MonoError *error)
{
	(void) alc;
	(void) assembly;
	(void) user_data;
	(void) error;
}

/* Thread-info runtime callbacks, mirroring mono/dis/main.c: no unwinding
 * support needed for a metadata dumper. */
static void
wasm_thread_state_init (MonoThreadUnwindState *ctx)
{
	(void) ctx;
}

#define wasm_setup_async_callback NULL
#define wasm_thread_state_init_from_sigctx NULL
#define wasm_thread_state_init_from_handle NULL

void
init_monodis (void)
{
	static const MonoThreadInfoRuntimeCallbacks ticallbacks = {
		MONO_THREAD_INFO_RUNTIME_CALLBACKS (MONO_INIT_CALLBACK, wasm)
	};

	if (initialized)
		return;
	/* Mirror mono/dis/main.c single-file init minus CLI parsing. */
	mono_counters_init ();
	mono_tls_init_runtime_keys ();
#ifndef HOST_WIN32
	mono_w32handle_init ();
#endif
	mono_thread_info_runtime_init (&ticallbacks);
	mono_install_assembly_load_hook_v2 (wasm_load_hook, NULL, FALSE);
	mono_install_assembly_search_hook_v2 (wasm_search_hook, NULL, FALSE, FALSE, FALSE);
	mono_install_assembly_preload_hook_v2 (wasm_preload_hook, NULL, FALSE, FALSE);
	init_key_table ();
	mono_init_metadata_only ("monodis");
	initialized = 1;
}

static char *
fail (const char *message)
{
	char *out = malloc (8 + strlen (message) + 1);
	if (!out)
		return NULL;
	strcpy (out, "Error: ");
	strcat (out, message);
	return out;
}

/* Minimal options parser: {"table":"--typedef","mscorlib":true,
 * "forward_decls":true,"header_data":true}. Unknown fields are ignored;
 * an unknown table name fails closed. */
static const char *
parse_options (const char *json)
{
	static char table [64];
	const char *key, *value, *end;
	size_t len;

	dump_table = -1;
	substitute_with_mscorlib_p = FALSE;
	dump_forward_decls = FALSE;
	dump_header_data_p = FALSE;
	dump_managed_resources = FALSE;
	table [0] = '\0';
	if (!json || !*json)
		return NULL;
	if (strstr (json, "\"mscorlib\":true"))
		substitute_with_mscorlib_p = TRUE;
	if (strstr (json, "\"forward_decls\":true"))
		dump_forward_decls = TRUE;
	if (strstr (json, "\"header_data\":true"))
		dump_header_data_p = TRUE;
	key = strstr (json, "\"table\"");
	if (!key)
		return NULL;
	value = strchr (key + 7, '"');
	if (!value)
		return "invalid options JSON";
	end = strchr (value + 1, '"');
	if (!end)
		return "invalid options JSON";
	len = (size_t) (end - value - 1);
	if (len == 0 || len >= sizeof (table))
		return "unknown table";
	memcpy (table, value + 1, len);
	table [len] = '\0';
	for (int i = 0; table_list [i].name != NULL; i++) {
		if (strcmp (table, table_list [i].name) == 0) {
			dump_table = i;
			return NULL;
		}
	}
	return "unknown table";
}

char *
monodis_disassemble (const uint8_t *bytes, int len, const char *options_json)
{
	FILE *staged;
	char *captured = NULL;
	size_t captured_len = 0;
	const char *options_error;
	int rc;

	if (!initialized)
		return fail ("not initialized");
	if (!bytes || len <= 0 || (uint32_t) len > MONODIS_MAX_INPUT)
		return fail ("input out of bounds");
	options_error = parse_options (options_json);
	if (options_error)
		return fail (options_error);

	staged = fopen (MONODIS_MEMFS_PATH, "wb");
	if (!staged)
		return fail ("out of memory");
	if (fwrite (bytes, 1, (size_t) len, staged) != (size_t) len) {
		fclose (staged);
		unlink (MONODIS_MEMFS_PATH);
		return fail ("out of memory");
	}
	fclose (staged);

	output = open_memstream (&captured, &captured_len);
	if (!output) {
		unlink (MONODIS_MEMFS_PATH);
		return fail ("out of memory");
	}
	rc = disassemble_file (MONODIS_MEMFS_PATH);
	fclose (output);
	unlink (MONODIS_MEMFS_PATH);

	if (rc != 0) {
		free (captured);
		return fail ("not a CIL image");
	}
	if (captured_len > MONODIS_MAX_OUTPUT) {
		static const char marker [] = "\n... output truncated at 4 MiB ...\n";
		size_t keep = MONODIS_MAX_OUTPUT - sizeof (marker);
		memmove (captured + keep, marker, sizeof (marker));
		captured [keep + sizeof (marker) - 1] = '\0';
	}
	return captured ? captured : fail ("no output");
}

void
free_string (char *pointer)
{
	free (pointer);
}
