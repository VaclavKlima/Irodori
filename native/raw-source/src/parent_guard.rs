//! Source-only Linux owner guard. This changes no RAW algorithm or pixel policy.
//! The guard deliberately stays armed until process exit; dropping the marker never clears it.

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("The source-only parent guard requires Linux x86_64.");

use std::ffi::{c_int, c_ulong};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::FromRawFd;
use std::os::unix::fs::MetadataExt;

const PR_SET_PDEATHSIG: c_int = 1;
const PR_GET_PDEATHSIG: c_int = 2;
const SIGKILL: c_ulong = 9;
const INPUT_LIMIT: u64 = 512 * 1024 * 1024;

unsafe extern "C" {
    fn getpid() -> c_int;
    fn getppid() -> c_int;
    fn fcntl(fd: c_int, command: c_int, ...) -> c_int;
    fn prctl(option: c_int, arg2: c_ulong, arg3: c_ulong, arg4: c_ulong, arg5: c_ulong) -> c_int;
}

pub struct ParentGuard;

fn parent_is(expected: c_int) -> io::Result<()> {
    // SAFETY: Linux process identity calls have no borrowed storage.
    if expected <= 1 || expected == unsafe { getpid() } || unsafe { getppid() } != expected {
        return Err(io::Error::other("The native RAW parent identity changed."));
    }
    Ok(())
}

fn install_inner(expected: c_int, before_arm: impl FnOnce() -> io::Result<()>) -> io::Result<ParentGuard> {
    parent_is(expected)?;
    before_arm()?;
    // SAFETY: Linux prctl ABI; SIGKILL is process-fatal and cannot be caught or ignored.
    if unsafe { prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // A death between the first check and prctl must fail before mapping/reading source bytes.
    parent_is(expected)?;
    let mut installed: c_int = 0;
    // SAFETY: PR_GET_PDEATHSIG writes one live c_int through this pointer.
    if unsafe { prctl(PR_GET_PDEATHSIG, (&mut installed as *mut c_int) as c_ulong, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if installed != SIGKILL as c_int {
        return Err(io::Error::other("The native RAW parent-death guard was not installed."));
    }
    parent_is(expected)?;
    Ok(ParentGuard)
}

pub fn install(expected_parent: c_int) -> io::Result<ParentGuard> {
    install_inner(expected_parent, || Ok(()))
}

// Compiled only into the isolated control probe. The production entry has no wait/test branch.
#[cfg(guard_control)]
pub fn install_with_before_arm(
    expected_parent: c_int,
    before_arm: impl FnOnce() -> io::Result<()>,
) -> io::Result<ParentGuard> {
    install_inner(expected_parent, before_arm)
}

pub struct PinnedSource {
    pub file: File,
    pub length: u64,
}

/// Takes ownership of the fixed inherited descriptor. No source pathname is accepted.
/// Main opens O_RDONLY|O_NOFOLLOW and passes the same descriptor it fstats and retains.
pub fn take_source_fd3(expected_dev: u64, expected_ino: u64, expected_length: u64) -> io::Result<PinnedSource> {
    // SAFETY: the sole entry point owns inherited descriptor 3; it has not created a File for it.
    let file = unsafe { File::from_raw_fd(3) };
    // SAFETY: F_GETFL=3 reads flags for the live inherited descriptor; O_ACCMODE=3.
    let flags = unsafe { fcntl(3, 3) };
    if flags < 0 { return Err(io::Error::last_os_error()); }
    if flags & 3 != 0 { return Err(io::Error::other("The inherited RAW source is not read-only.")); }
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || expected_length == 0
        || expected_length > INPUT_LIMIT
        || metadata.dev() != expected_dev
        || metadata.ino() != expected_ino
        || metadata.len() != expected_length
    {
        return Err(io::Error::other("The inherited native RAW source identity is invalid."));
    }
    Ok(PinnedSource { file, length: expected_length })
}

/// The main owner writes this exact bounded token only after the receiver has installed its reader.
/// The source can be fstat'ed before this gate, but must not be mapped, decoded, or read before it.
pub fn wait_for_start(input: &mut impl Read, nonce: &str) -> io::Result<()> {
    if nonce.len() != 32 || !nonce.bytes().all(|v| v.is_ascii_hexdigit() && !v.is_ascii_uppercase()) {
        return Err(io::Error::other("Invalid native RAW start identity."));
    }
    let expected = format!("IRODORI-RAW-START1 {nonce}\n");
    let mut token = vec![0; expected.len()];
    input.read_exact(&mut token)?;
    if token != expected.as_bytes() {
        return Err(io::Error::other("Native RAW start acknowledgement mismatch."));
    }
    let mut excess = [0];
    if input.read(&mut excess)? != 0 {
        return Err(io::Error::other("Excess native RAW start bytes."));
    }
    Ok(())
}
