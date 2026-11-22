use git2::{
    ConfigLevel, Delta, DiffOptions, ErrorCode, IndexEntryExtendedFlag, Repository,
    RepositoryOpenFlags,
};
use std::collections::{BTreeSet, HashSet};
use std::error::Error;
use std::ffi::OsStr;
use std::io::{self, BufWriter, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, mpsc};
use std::{env, fs, thread};

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = env::args_os().skip(1);
    let git_dir = args.next().ok_or("missing git directory")?;
    if git_dir == "--serve" {
        let shadow_root = args
            .next()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .and_then(|path| path.canonicalize().ok());
        return serve(shadow_root.as_deref());
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
    if !git_dir.is_absolute()
        || !worktree.is_absolute()
        || scope.is_empty()
        || Path::new(scope)
            .components()
            .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("invalid snapshot scan roots or scope".into());
    }
    // Core supplies the worktree and its shadow index over the private worker pipe.
    // Open the exact directory and constrain the requested pathspec to that worktree.
    let git_dir = git_dir.canonicalize()?;
    let worktree = worktree.canonicalize()?;
    let repository = Repository::open(&git_dir)?;
    if repository.path().canonicalize()? != git_dir {
        return Err("unexpected Git directory".into());
    }
    repository.set_workdir(&worktree, false)?;
    apply_worker_config(&mut repository.config()?)?;
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
        let mut checked_parents = HashSet::new();
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
            let worktree_path = worktree.join(OsStr::from_bytes(path));
            let parent = worktree_path.parent().ok_or("missing index entry parent")?;
            if !checked_parents.contains(parent) {
                match parent.canonicalize() {
                    Ok(resolved) if resolved == parent && resolved.starts_with(&worktree) => {
                        checked_parents.insert(resolved);
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    _ => return Err("redirected index entry parent requires Git".into()),
                }
            }
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

fn write_tree(
    shadow_root: &Path,
    project: &[u8],
    checkout: &[u8],
) -> Result<Vec<u8>, Box<dyn Error>> {
    for name in [project, checkout] {
        if name.is_empty()
            || !name
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(b))
        {
            return Err("invalid shadow repository identifier".into());
        }
    }
    let git_dir = shadow_root
        .join(OsStr::from_bytes(project))
        .join(OsStr::from_bytes(checkout))
        .canonicalize()?;
    if !git_dir.starts_with(shadow_root)
        || git_dir.parent().and_then(Path::parent) != Some(shadow_root)
    {
        return Err("snapshot tree writes require a shadow repository".into());
    }
    let objects = git_dir.join("objects");
    if !fs::symlink_metadata(&objects)?.is_dir()
        || !fs::symlink_metadata(git_dir.join("index"))?.is_file()
    {
        return Err("redirected or missing shadow storage requires Git".into());
    }
    // Loose tree objects are written into the two-character fanout directories under objects.
    for entry in fs::read_dir(&objects)? {
        if entry?.file_type()?.is_symlink() {
            return Err("redirected shadow object storage requires Git".into());
        }
    }
    let repository = Repository::open_ext(
        &git_dir,
        RepositoryOpenFlags::NO_SEARCH | RepositoryOpenFlags::NO_DOTGIT | RepositoryOpenFlags::BARE,
        &[] as &[&OsStr],
    )?;
    if repository.path().canonicalize()? != git_dir
        || repository.commondir().canonicalize()? != git_dir
    {
        return Err("unexpected shadow Git directory".into());
    }
    let mut settings = repository.config()?;
    for key in [
        "core.fsync",
        "core.fsyncmethod",
        "core.fsyncobjectfiles",
        "core.sharedrepository",
    ] {
        if !matches!(settings.get_entry(key), Err(error) if error.code() == ErrorCode::NotFound) {
            return Err("configured Git object writes require Git".into());
        }
    }
    apply_worker_config(&mut settings)?;
    let mut index = repository.index()?;
    if index.iter().any(|item| {
        item.flags_extended & IndexEntryExtendedFlag::INTENT_TO_ADD.bits() != 0
            || item.mode == 0o040000
    }) {
        return Err("intent-to-add or sparse entries require Git".into());
    }
    let tree = index.write_tree_to(&repository)?;
    // An index can cache a tree ID even if the object was pruned from its object store.
    repository.find_tree(tree)?;
    Ok(tree.to_string().into_bytes())
}

fn apply_worker_config(settings: &mut git2::Config) -> Result<(), Box<dyn Error>> {
    settings.add_file(
        &env::current_exe()?.with_file_name("snapshot-scan.gitconfig"),
        ConfigLevel::App,
        true,
    )?;
    Ok(())
}

const MAX_REQUEST_BYTES: u32 = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const THREADS: usize = 4;

struct Request {
    id: [u8; 4],
    payload: Vec<u8>,
}

fn serve(shadow_root: Option<&Path>) -> Result<(), Box<dyn Error>> {
    let (sender, receiver) = mpsc::sync_channel::<Request>(THREADS);
    let receiver = Mutex::new(receiver);
    let output = Mutex::new(BufWriter::new(io::stdout()));
    thread::scope(|threads| {
        for _ in 0..THREADS {
            threads.spawn(|| {
                loop {
                    let request = receiver.lock().unwrap().recv();
                    let Ok(request) = request else { break };
                    let fields = request.payload.split(|&byte| byte == 0).collect::<Vec<_>>();
                    let response = match fields.as_slice() {
                        [b"write-tree", project, checkout] => match shadow_root {
                            Some(root) => write_tree(root, project, checkout),
                            None => {
                                Err("snapshot tree writes require a configured shadow root".into())
                            }
                        },
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
                        _ => Err("invalid snapshot request".into()),
                    };
                    let (status, bytes) = match response {
                        Ok(bytes) if bytes.len() <= MAX_RESPONSE_BYTES => (0, bytes),
                        Ok(_) => (1, b"snapshot response too large".to_vec()),
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
        let mut payload = vec![0u8; size as usize - 4];
        input.read_exact(&mut payload)?;
        sender
            .send(Request { id, payload })
            .map_err(io::Error::other)?;
    }
}
