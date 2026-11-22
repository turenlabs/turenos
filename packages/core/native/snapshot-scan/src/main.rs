use git2::{ConfigLevel, Delta, DiffOptions, Repository};
use std::collections::BTreeSet;
use std::error::Error;
use std::ffi::OsStr;
use std::io::{self, BufWriter, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::{Mutex, mpsc};
use std::{env, fs, thread};

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args_os().skip(1);
    let git_dir = args.next().ok_or("missing git directory")?;
    if git_dir == "--serve" {
        return serve();
    }
    let worktree = args.next().ok_or("missing worktree")?;
    let scope = args.next().ok_or("missing scope")?;
    let include_stat = args
        .next()
        .is_some_and(|argument| argument == "--include-stat");
    let changes = scan(
        Path::new(&git_dir),
        Path::new(&worktree),
        &scope,
        include_stat,
    )?;
    io::stdout().lock().write_all(&changes)?;
    Ok(())
}

fn scan(
    git_dir: &Path,
    worktree: &Path,
    scope: &OsStr,
    include_stat: bool,
) -> Result<Vec<u8>, Box<dyn Error>> {
    if env::var_os("GIT_INDEX_FILE").is_some() {
        return Err("alternate Git index requires the Git scanner".into());
    }
    let repository = Repository::open(git_dir)?;
    repository.set_workdir(worktree, false)?;
    let mut settings = repository.config()?;
    settings.add_file(
        &env::current_exe()?.with_file_name("snapshot-scan.gitconfig"),
        ConfigLevel::App,
        true,
    )?;
    let index = repository.index()?;
    let mut options = DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_typechange(true)
        .include_unreadable(true);
    if scope != "." {
        options.pathspec(scope);
    }
    let diff = repository.diff_index_to_workdir(Some(&index), Some(&mut options))?;
    let mut changes = BTreeSet::new();
    for entry in diff.deltas() {
        let kind = if entry.status() == Delta::Untracked {
            b'U'
        } else {
            b'T'
        };
        let path = if entry.status() == Delta::Deleted {
            entry.old_file().path_bytes()
        } else {
            entry.new_file().path_bytes()
        }
        .ok_or("missing path in diff")?;
        changes.insert((kind, path.to_vec()));
    }
    if include_stat {
        let config = repository.config()?;
        let trust_ctime = config.get_bool("core.trustctime").unwrap_or(true);
        let minimal_stat = config
            .get_string("core.checkStat")
            .is_ok_and(|value| value == "minimal");
        let scope = scope.as_bytes();
        for entry in index.iter() {
            let path = &entry.path[..];
            if path.split(|&b| b == b'/').any(|component| {
                component.is_empty()
                    || component == b"."
                    || component == b".."
                    || component.eq_ignore_ascii_case(b".git")
            }) {
                return Err("invalid path in Git index".into());
            }
            let in_scope = scope == b"."
                || path == scope
                || path
                    .strip_prefix(scope)
                    .is_some_and(|suffix| suffix.starts_with(b"/"));
            let assume_unchanged = entry.flags & 0x8000 != 0;
            let skip_worktree = entry.flags_extended & 0x4000 != 0;
            let regular = entry.mode & 0o170000 == 0o100000;
            let symlink = entry.mode == 0o120000;
            if !in_scope || assume_unchanged || skip_worktree || !(regular || symlink) {
                continue;
            }
            let worktree_path = worktree.join(std::ffi::OsStr::from_bytes(path));
            let Ok(metadata) = fs::symlink_metadata(worktree_path) else {
                continue;
            };
            let mtime_changed = entry.mtime.seconds() != metadata.mtime() as i32
                || (!minimal_stat && entry.mtime.nanoseconds() != metadata.mtime_nsec() as u32);
            let ctime_changed = trust_ctime
                && !minimal_stat
                && (entry.ctime.seconds() != metadata.ctime() as i32
                    || entry.ctime.nanoseconds() != metadata.ctime_nsec() as u32);
            let identity_changed = !minimal_stat
                && (entry.ino != metadata.ino() as u32
                    || entry.uid != metadata.uid()
                    || entry.gid != metadata.gid());
            let size_changed = entry.file_size != metadata.size() as u32;
            if mtime_changed || ctime_changed || identity_changed || size_changed {
                changes.insert((b'T', entry.path));
            }
        }
    }
    let mut out = Vec::new();
    for (kind, path) in changes {
        out.push(kind);
        out.extend_from_slice(&path);
        out.push(0);
    }
    Ok(out)
}

const MAX_REQUEST_BYTES: u32 = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const THREADS: usize = 4;

struct Request {
    id: [u8; 4],
    paths: Vec<u8>,
}

fn serve() -> Result<(), Box<dyn Error>> {
    let (sender, receiver) = mpsc::sync_channel::<Request>(THREADS);
    let receiver = Mutex::new(receiver);
    let output = Mutex::new(BufWriter::new(io::stdout()));
    thread::scope(|threads| {
        for _ in 0..THREADS {
            threads.spawn(|| {
                loop {
                    let request = receiver.lock().unwrap().recv();
                    let Ok(request) = request else { break };
                    let fields = request.paths.split(|&byte| byte == 0).collect::<Vec<_>>();
                    let response = match fields.as_slice() {
                        [git_dir, worktree, scope]
                            if fields.iter().all(|part| !part.is_empty()) =>
                        {
                            scan(
                                Path::new(OsStr::from_bytes(git_dir)),
                                Path::new(OsStr::from_bytes(worktree)),
                                OsStr::from_bytes(scope),
                                true,
                            )
                        }
                        _ => Err("invalid scan request".into()),
                    };
                    let (status, bytes) = match response {
                        Ok(bytes) if bytes.len() <= MAX_RESPONSE_BYTES => (0, bytes),
                        Ok(_) => (1, b"scan output too large".to_vec()),
                        Err(error) => (1, error.to_string().into_bytes()),
                    };
                    let mut stdout = output.lock().unwrap();
                    let result = stdout
                        .write_all(&((bytes.len() as u32) + 5).to_be_bytes())
                        .and_then(|()| stdout.write_all(&request.id))
                        .and_then(|()| stdout.write_all(&[status]))
                        .and_then(|()| stdout.write_all(&bytes))
                        .and_then(|()| stdout.flush());
                    if result.is_err() {
                        break;
                    }
                }
            });
        }
        read_requests(sender)
    })?;
    Ok(())
}

fn read_requests(sender: mpsc::SyncSender<Request>) -> io::Result<()> {
    let mut input = io::stdin().lock();
    loop {
        let mut header = [0u8; 4];
        if input.read(&mut header[..1])? == 0 {
            return Ok(());
        }
        input.read_exact(&mut header[1..])?;
        let size = u32::from_be_bytes(header);
        if !(5..=MAX_REQUEST_BYTES).contains(&size) {
            return Err(io::Error::other("invalid request length"));
        }
        let mut id = [0u8; 4];
        input.read_exact(&mut id)?;
        let mut paths = vec![0u8; size as usize - 4];
        input.read_exact(&mut paths)?;
        sender
            .send(Request { id, paths })
            .map_err(io::Error::other)?;
    }
}
