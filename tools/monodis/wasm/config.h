/* Hand-written Emscripten config for the monodis WASM subset.
 *
 * This replaces the autoconf-generated config.h. Mono sources include it as
 * <config.h>; Makefile.wasm puts this directory first on the include path.
 * SPIKE: grow this file only with symbols the compiler actually demands.
 * Every symbol here must be justifiable for wasm32 single-threaded MEMFS.
 */
#ifndef MONODIS_WASM_CONFIG_H
#define MONODIS_WASM_CONFIG_H

/* Platform identity: 32-bit little-endian WebAssembly, no threads. */
#define SIZEOF_VOID_P 4
#define SIZEOF_LONG 4
#define SIZEOF_INT 4
#define SIZEOF_SIZE_T 4
#define SIZEOF_REGISTER 4
#define TARGET_SIZEOF_VOID_P 4
#define HOST_WASM 1

/* Common HAVE_* probes. Emscripten provides these headers. */
#define HAVE_UNISTD_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_SYS_TIME_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_FCNTL_H 1
#define HAVE_DLFCN_H 1
#define HAVE_PTHREAD_H 1
#define HAVE_SEMAPHORE_H 1
#define HAVE_UTIME_H 1
#define HAVE_TERMIOS_H 1
#define HAVE_SYS_IOCTL_H 1
#define HAVE_POLL 1
#define HAVE_POLL_H 1
#define HAVE_SYS_POLL_H 1
#define HAVE_SYS_WAIT_H 1
#define HAVE_NETDB_H 1
#define HAVE_SYS_MMAN_H 1
#define HAVE_ARPA_INET_H 1
#define HAVE_SYS_SOCKET_H 1
#define HAVE_NETINET_IN_H 1
#define HAVE_GETPROTOBYNAME 1
/* Networking probes for mono/utils/networking-posix.c. Emscripten's musl
 * sysroot provides getaddrinfo, getifaddrs, getnameinfo, and net/if.h.
 * These back managed-socket icalls that a metadata dumper never invokes;
 * defining them selects real upstream code over stubs. */
#define HAVE_GETADDRINFO 1
#define HAVE_GETIFADDRS 1
#define HAVE_GETNAMEINFO 1
#define HAVE_NET_IF_H 1
/* Emscripten provides a functional mmap. HAVE_MMAP disables mono-filemap.c's
 * file-I/O fallback so it does not collide with mono-mmap-wasm.c, which is
 * the real implementation under HOST_WASM (mono-mmap.c's unix body is in
 * the #else branch and contributes only mem-account helpers). */
#define HAVE_MMAP 1

/* Classic Win32 API subset emulated on unix (w32*-unix.c). configure.ac
 * defines these unconditionally for classic targets. */
#define HAVE_CLASSIC_WINAPI_SUPPORT 1
#define HAVE_UWP_WINAPI_SUPPORT 0

/* Corlib-runtime interface version, from configure.ac MONO_CORLIB_VERSION.
 * Only used for mismatch diagnostics when loading a real corlib, which the
 * refonly WASM bridge never does. */
#define MONO_CORLIB_VERSION "1A5E0066-58DC-428A-B21C-0AD6CDAE2789"

/* Explicitly absent: used to steer mono/utils platform backends. */
#undef HAVE_KQUEUE
#undef HAVE_EPOLL

#endif /* MONODIS_WASM_CONFIG_H */
