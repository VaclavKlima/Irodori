#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("The RAW sensor prototype currently targets Linux x86_64 only.");
mod rows;
mod parent_guard;

use std::env;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::fs::{self, File};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::ptr::NonNull;
use std::time::Instant;

const PACKED_LIMIT: usize = 128 * 1024 * 1024;
const ADDRESS_SPACE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const RAW_ALLOCATION_LIMIT: usize = 256 * 1024 * 1024;
const HEADER_LIMIT: usize = 64 * 1024;
const TRAILER_LIMIT: usize = 16 * 1024;
const CONTRACT: &str = "irodori-parallel-sony-arw2-rows-v1";

#[repr(C)]
struct ResourceLimit {
    current: u64,
    maximum: u64,
}

extern "C" {
    fn mmap(
        address: *mut c_void,
        length: usize,
        protection: c_int,
        flags: c_int,
        file: c_int,
        offset: i64,
    ) -> *mut c_void;
    fn munmap(address: *mut c_void, length: usize) -> c_int;
    fn setrlimit(resource: c_int, limit: *const ResourceLimit) -> c_int;
    fn irodori_raw_create() -> *mut c_void;
    fn irodori_raw_destroy(handle: *mut c_void);
    fn irodori_raw_error(handle: *mut c_void) -> *const c_char;
    fn irodori_raw_metadata(handle: *mut c_void) -> *const c_char;
    fn irodori_raw_row_diagnostics(handle: *mut c_void) -> *const c_char;
    fn irodori_raw_configure_rows(handle: *mut c_void, mode: u32, threads: u32) -> c_int;
    fn irodori_raw_rows(handle: *mut c_void) -> *const u16;
    fn irodori_raw_row_width(handle: *mut c_void) -> usize;
    fn irodori_raw_row_count(handle: *mut c_void) -> usize;
    fn irodori_raw_row_stride(handle: *mut c_void) -> usize;
    fn irodori_raw_open(handle: *mut c_void, input: *const u8, length: usize) -> c_int;
    fn irodori_raw_unpack(handle: *mut c_void) -> c_int;
    fn irodori_raw_prepare_rows(handle: *mut c_void) -> c_int;
    fn irodori_raw_release_rows(handle: *mut c_void) -> c_int;
    fn irodori_raw_peak_rss_bytes() -> u64;
}

struct Input {
    address: NonNull<c_void>,
    length: usize,
    // This inherited FD stays owned through all mapping and LibRaw borrows.
    _source: parent_guard::PinnedSource,
}
impl Input {
    fn map(source: parent_guard::PinnedSource) -> Result<Self, Box<dyn std::error::Error>> {
        if source.file.metadata()?.len() != source.length {
            return Err("The pinned RAW source length changed before mapping.".into());
        }
        let length = usize::try_from(source.length)?;
        // SAFETY: the armed guard and exact start gate preceded this first source mapping.
        // The validated inherited read-only regular FD remains owned by this Input.
        let pointer = unsafe { mmap(std::ptr::null_mut(), length, 1, 2, source.file.as_raw_fd(), 0) };
        if pointer as isize == -1 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(Self {
            address: NonNull::new(pointer).ok_or("RAW mapping failed.")?,
            length,
            _source: source,
        })
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        // SAFETY: the decoder is destroyed before its immutable input mapping is released.
        unsafe {
            munmap(self.address.as_ptr(), self.length);
        }
    }
}

struct Decoder(NonNull<c_void>);
impl Decoder {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        // SAFETY: the bridge returns a fresh opaque owner or null; no shared decoder exists.
        Ok(Self(
            NonNull::new(unsafe { irodori_raw_create() }).ok_or("RAW decoder allocation failed.")?,
        ))
    }
    fn check(&self, status: c_int) -> Result<(), Box<dyn std::error::Error>> {
        if status == 0 {
            return Ok(());
        }
        // SAFETY: this live owner holds the bounded NUL-terminated bridge error string.
        let message = unsafe { CStr::from_ptr(irodori_raw_error(self.0.as_ptr())) }.to_str()?;
        Err(message.to_owned().into())
    }
    fn metadata(&self) -> Result<String, Box<dyn std::error::Error>> {
        // SAFETY: the bridge owns this bounded NUL-terminated JSON until its next call.
        let value = unsafe { CStr::from_ptr(irodori_raw_metadata(self.0.as_ptr())) }.to_str()?;
        if value.len() > 16 * 1024 || !value.starts_with('{') || !value.ends_with('}') {
            return Err("Invalid RAW metadata envelope.".into());
        }
        Ok(value.to_owned())
    }
}
impl Drop for Decoder {
    fn drop(&mut self) {
        // SAFETY: exactly one owner destroys this handle after all pixel borrows end.
        unsafe {
            irodori_raw_destroy(self.0.as_ptr());
        }
    }
}

fn frame(
    output: &mut impl Write,
    magic: &[u8; 8],
    json: &str,
    limit: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    if json.is_empty() || json.len() > limit {
        return Err("Native RAW JSON frame exceeds its bound.".into());
    }
    output.write_all(magic)?;
    output.write_all(&u32::try_from(json.len())?.to_le_bytes())?;
    output.write_all(json.as_bytes())?;
    Ok(())
}

fn threads() -> Result<u64, Box<dyn std::error::Error>> {
    let status = fs::read_to_string("/proc/self/status")?;
    let count = status
        .lines()
        .find_map(|line| line.strip_prefix("Threads:"))
        .ok_or("Missing thread count.")?
        .trim()
        .parse()?;
    Ok(count)
}

fn decimal(value: &str) -> Result<u64, Box<dyn std::error::Error>> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|v| v.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0')) {
        return Err("Invalid canonical native RAW descriptor number.".into());
    }
    Ok(value.parse()?)
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = env::args_os().skip(1)
        .map(|value| value.into_string().map_err(|_| "Non-ASCII native RAW arguments."))
        .collect::<Result<_, _>>()?;
    if arguments.len() != 6 || arguments[0] != "--owned-rows-v1" {
        return Err("Usage: irodori-raw --owned-rows-v1 EXPECTED_MAIN_PID NONCE DEV INO LENGTH".into());
    }
    let expected_parent = c_int::try_from(decimal(&arguments[1])?)?;
    let nonce = &arguments[2];
    if nonce.len() != 32 || !nonce.bytes().all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v)) {
        return Err("Invalid native RAW request nonce.".into());
    }
    let dev = decimal(&arguments[3])?;
    let ino = decimal(&arguments[4])?;
    let length = decimal(&arguments[5])?;
    // Fixed production entry: there are no research mode/thread/environment selectors.
    let mode = 1;
    let row_threads = 8;
    let started = Instant::now();
    // Install before taking the source descriptor, readiness, mapping or any LibRaw work.
    // The marker intentionally never disarms the process-fatal parent-death guard.
    let _guard = parent_guard::install(expected_parent)?;
    if u16::from_ne_bytes([1, 0]) != 1 {
        return Err("Little-endian storage is required.".into());
    }
    let limit = ResourceLimit {
        current: ADDRESS_SPACE_LIMIT,
        maximum: ADDRESS_SPACE_LIMIT,
    };
    // SAFETY: Linux x86_64 RLIMIT_AS=9. This limits virtual address space, not RSS.
    if unsafe { setrlimit(9, &limit) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    let source = parent_guard::take_source_fd3(dev, ino, length)?;
    {
        // SAFETY: the entry owns fixed inherited readiness FD4 exactly once.
        let mut ready = unsafe { File::from_raw_fd(4) };
        ready.write_all(format!("ARMED {nonce}\n").as_bytes())?;
        ready.flush()?;
    } // FD4 EOF is required before the main owner can start this decoder.
    parent_guard::wait_for_start(&mut io::stdin().lock(), nonce)?;
    let input_started = Instant::now();
    let input = Input::map(source)?;
    let input_ms = input_started.elapsed().as_secs_f64() * 1000.0;
    let decoder = Decoder::new()?;
    // SAFETY: configure this fresh owner before open; no threads or borrows exist yet.
    decoder.check(unsafe { irodori_raw_configure_rows(decoder.0.as_ptr(), mode, row_threads) })?;
    let open_started = Instant::now();
    // SAFETY: the read-only mapping outlives this decoder and every LibRaw call.
    decoder.check(unsafe {
        irodori_raw_open(
            decoder.0.as_ptr(),
            input.address.as_ptr().cast(),
            input.length,
        )
    })?;
    let open_ms = open_started.elapsed().as_secs_f64() * 1000.0;
    let opened = decoder.metadata()?;
    let unpack_started = Instant::now();
    // SAFETY: opened live handle; the bridge permits exactly one unpack.
    decoder.check(unsafe { irodori_raw_unpack(decoder.0.as_ptr()) })?;
    let unpack_ms = unpack_started.elapsed().as_secs_f64() * 1000.0;
    // SAFETY: bounded immutable JSON belongs to this owner; clone before any later bridge call.
    let row_kernel = unsafe { CStr::from_ptr(irodori_raw_row_diagnostics(decoder.0.as_ptr())) }.to_str()?.to_owned();
    if row_kernel.len() > 4096 || !row_kernel.starts_with('{') || !row_kernel.ends_with('}') {
        return Err("Invalid row-kernel diagnostics.".into());
    }
    let prepare_started = Instant::now();
    // SAFETY: the bridge validates initialized Bayer storage and retains it until release.
    decoder.check(unsafe { irodori_raw_prepare_rows(decoder.0.as_ptr()) })?;
    let unpacked = decoder.metadata()?;
    // SAFETY: live prepared handle; these immutable dimensions describe its borrowed rows.
    let (rows, width, height, stride) = unsafe {
        (
            irodori_raw_rows(decoder.0.as_ptr()),
            irodori_raw_row_width(decoder.0.as_ptr()),
            irodori_raw_row_count(decoder.0.as_ptr()),
            irodori_raw_row_stride(decoder.0.as_ptr()),
        )
    };
    let row_bytes = width.checked_mul(2).ok_or("RAW row length overflow.")?;
    let byte_length = row_bytes
        .checked_mul(height)
        .ok_or("RAW byte length overflow.")?;
    let storage_bytes = stride
        .checked_mul(height)
        .and_then(|samples| samples.checked_mul(2))
        .ok_or("RAW storage length overflow.")?;
    if rows.is_null()
        || width == 0
        || height == 0
        || width > 32768
        || height > 32768
        || stride < width
        || byte_length > PACKED_LIMIT
        || storage_bytes > RAW_ALLOCATION_LIMIT
    {
        return Err("Invalid live packed sensor rows.".into());
    }
    let prepare_ms = prepare_started.elapsed().as_secs_f64() * 1000.0;
    if threads()? != 1 {
        return Err("The native RAW decoder retained row tasks after its join barrier.".into());
    }
    let header = format!(
        "{{\"contract\":\"{CONTRACT}\",\"protocol\":\"u16le-live-rows-v2\",\"rowKernel\":{row_kernel},\"opened\":{opened},\"unpacked\":{unpacked},\"packedBytes\":{byte_length},\"sourceLayout\":{{\"rowSamples\":{width},\"rowCount\":{height},\"strideSamples\":{stride}}}}}"
    );
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let header_started = Instant::now();
    frame(&mut output, b"IRODRAW2", &header, HEADER_LIMIT)?;
    let header_ms = header_started.elapsed().as_secs_f64() * 1000.0;
    let write_started = Instant::now();
    // SAFETY: the validated live LibRaw allocation remains initialized and immutable through
    // every blocking write. Only row padding is omitted; no host packed allocation is made.
    if stride == width {
        let bytes = unsafe { std::slice::from_raw_parts(rows.cast::<u8>(), byte_length) };
        output.write_all(bytes)?;
    } else {
        for row in 0..height {
            let bytes = unsafe {
                std::slice::from_raw_parts(rows.add(row * stride).cast::<u8>(), row_bytes)
            };
            output.write_all(bytes)?;
        }
    }
    output.flush()?;
    let write_ms = write_started.elapsed().as_secs_f64() * 1000.0;
    let recycle_started = Instant::now();
    // SAFETY: all borrowed slices and blocking writes ended before this release.
    decoder.check(unsafe { irodori_raw_release_rows(decoder.0.as_ptr()) })?;
    let recycle_ms = recycle_started.elapsed().as_secs_f64() * 1000.0;
    let thread_count = threads()?;
    if thread_count != 1 {
        return Err("The native RAW decoder retained row tasks after its join barrier.".into());
    }
    // SAFETY: getrusage wrapper returns observed self peak RSS in Linux bytes, or zero on error.
    let peak_rss = unsafe { irodori_raw_peak_rss_bytes() };
    if peak_rss == 0 {
        return Err("Native RAW peak RSS observation failed.".into());
    }
    let total_ms = started.elapsed().as_secs_f64() * 1000.0;
    let trailer = format!(
        "{{\"contract\":\"{CONTRACT}\",\"complete\":true,\"packedBytes\":{byte_length},\"rowsWritten\":{height},\"timings\":{{\"inputMapMs\":{input_ms},\"openMs\":{open_ms},\"unpackMs\":{unpack_ms},\"prepareLiveRowsMs\":{prepare_ms},\"headerWriteMs\":{header_ms},\"payloadWriteWithBackpressureMs\":{write_ms},\"recycleMs\":{recycle_ms},\"totalBeforeTrailerMs\":{total_ms}}},\"process\":{{\"threads\":{thread_count},\"peakRssBytes\":{peak_rss},\"addressSpaceLimitBytes\":{ADDRESS_SPACE_LIMIT},\"librawRawAllocationLimitBytes\":{RAW_ALLOCATION_LIMIT},\"packedLimitBytes\":{PACKED_LIMIT}}}}}"
    );
    frame(&mut output, b"IRODEND2", &trailer, TRAILER_LIMIT)?;
    output.flush()?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Native RAW source failed: {error}");
        std::process::exit(1);
    }
}
