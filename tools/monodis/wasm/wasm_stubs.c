/* Driver shims for symbols the Blazor/JIT drivers normally provide.
 *
 * These definitions close the link for the single-threaded,
 * metadata-only WASM target. None of them changes upstream behavior on
 * paths monodis exercises; each is documented below. They live outside
 * upstream/ so the pinned Mono sources stay unpatched.
 */
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <semaphore.h>
#include <time.h>

#include <glib.h>

/* sgen asks the driver whether GC is enabled (Blazor sets this from JS once
 * the runtime is ready). monodis links sgen and allocates through it from
 * the first call, so GC is unconditionally on. When FALSE, sgen would skip
 * thread-stack scanning and parts of init; we always want the normal path. */
gboolean mono_wasm_enable_gc = TRUE;

/* mono-threads-wasm.c calls this when the first background job (finalizers,
 * threadpool callbacks) is queued; the Blazor driver then pumps
 * mono_background_exec() from the JS event loop. This target has no event
 * loop, so drain eagerly: mono_background_exec() detaches the list before
 * running it, so jobs queued during the drain recurse safely. */
void mono_background_exec (void);

void
schedule_background_exec (void)
{
	mono_background_exec ();
}

/* Thread-priority setter used only when managed code changes a thread's
 * priority, which a metadata dumper never does. Emscripten declares this
 * in pthread.h but does not implement it without pthreads; claim success. */
int
pthread_setschedparam (pthread_t thread, int policy, const struct sched_param *param)
{
	(void) thread;
	(void) policy;
	(void) param;
	return 0;
}

/* Emscripten implements sem_trywait but not sem_timedwait. Single-threaded
 * WASM has no preemption, so a semaphore that is unavailable now can only
 * become available via calls on this same thread: spin on trywait until
 * the absolute CLOCK_REALTIME deadline, preserving timeout semantics
 * without ever deadlocking the worker. */
int
sem_timedwait (sem_t *sem, const struct timespec *abstime)
{
	struct timespec now;

	if (!sem || !abstime) {
		errno = EINVAL;
		return -1;
	}
	for (;;) {
		if (sem_trywait (sem) == 0)
			return 0;
		if (errno != EAGAIN)
			return -1;
		clock_gettime (CLOCK_REALTIME, &now);
		if (now.tv_sec > abstime->tv_sec ||
		    (now.tv_sec == abstime->tv_sec && now.tv_nsec >= abstime->tv_nsec)) {
			errno = ETIMEDOUT;
			return -1;
		}
	}
}

/* Provided by the Blazor WebAssembly SDK outside the runtime
 * (mono/metadata/icall.c says so explicitly); reached only from managed
 * TimeZoneInfo code, which a metadata dumper never executes. Report
 * unknown rather than crashing if it is ever called. */
void
mono_timezone_get_local_name (void **result)
{
	if (result)
		*result = NULL;
}

/* Unix implementation in mono/metadata/w32file-unix.c is guarded for
 * Darwin/Linux/BSD/AIX only, so HOST_WASM has no definition. Reached
 * only from managed DriveInfo code; report unknown filesystem. */
gboolean
mono_w32file_get_file_system_type (const gunichar2 *path, gunichar2 *fsbuffer, gint fsbuffersize)
{
	(void) path;
	(void) fsbuffer;
	(void) fsbuffersize;
	return FALSE;
}
