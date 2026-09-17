/* Hand-written eglib config for the monodis WASM subset.
 *
 * Manual substitution of mono/eglib/eglib-config.h.in for wasm32 Emscripten
 * (single-threaded, unix, little-endian). Upstream already anticipates WASM
 * via the HOST_WASM G_BREAKPOINT branch; HOST_WASM comes from wasm/config.h.
 */
#ifndef __EGLIB_CONFIG_H
#define __EGLIB_CONFIG_H

#define G_GNUC_PRETTY_FUNCTION __func__
#define G_GNUC_UNUSED __attribute__((__unused__))
#define G_BYTE_ORDER 1234
#define G_GNUC_NORETURN __attribute__((__noreturn__))
#define G_SEARCHPATH_SEPARATOR_S ":"
#define G_SEARCHPATH_SEPARATOR ':'
#define G_DIR_SEPARATOR '/'
#define G_DIR_SEPARATOR_S "/"
#define G_BREAKPOINT() G_STMT_START { printf ("MONO: BREAKPOINT\n"); abort (); } G_STMT_END
#define G_OS_UNIX

#define G_HAVE_ALLOCA_H
#define G_HAVE_UNISTD_H

typedef __SIZE_TYPE__ gsize;
typedef __PTRDIFF_TYPE__ gssize;

#define G_GSIZE_FORMAT "u"

typedef int GPid;

#endif /* __EGLIB_CONFIG_H */
