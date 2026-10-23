//! Bounded explicit mask mode candidate; ordinary CPU preview mode stays separate.
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("The isolated mask host currently supports Linux x86_64 only.");

use std::ffi::{c_char, c_int, c_void, CStr};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::ptr::NonNull;
use std::thread;
use std::time::Instant;

const REQUEST_BYTES: usize = 416;
const TERMINAL_BYTES: usize = 72;
const SOURCE_LIMIT: u64 = 512 * 1024 * 1024;
const STRIP_ROWS: u32 = 64;
const WRITER_BYTES: usize = 64 * 1024;
const WORKER_STACK_BYTES: usize = 512 * 1024;
const KNOWN_FLAGS: u32 = 1 | 2 | 16;

// Bound to the same preparation output as the embedded capability. Decode at
// compile time: no runtime allocation, JSON parser or mutable capability file.
const fn arithmetic_identity() -> [u8; 32] {
    let text = env!("LUMA_MASK_ARITHMETIC_SHA256").as_bytes();
    assert!(text.len() == 64, "Invalid native mask arithmetic identity length.");
    let mut bytes = [0u8; 32];
    let mut index = 0;
    while index < text.len() {
        let digit = match text[index] {
            b'0'..=b'9' => text[index] - b'0',
            b'a'..=b'f' => text[index] - b'a' + 10,
            _ => panic!("Invalid native mask arithmetic identity encoding."),
        };
        if index % 2 == 0 {
            bytes[index / 2] = digit << 4;
        } else {
            bytes[index / 2] |= digit;
        }
        index += 1;
    }
    bytes
}
const ARITHMETIC_SHA256: [u8; 32] = arithmetic_identity();

// Matches the existing production bridge.h LumaCpuParams, including C padding.
#[repr(C)]
struct Params {
    exposure: f64,
    contrast: f64,
    highlights: f64,
    shadows: f64,
    whites: f64,
    blacks: f64,
    wb: [f64; 9],
    headroom: f64,
    flags: u32,
}

unsafe extern "C" {
    fn luma_mask_context_create(aces: *const f64, proof: *const f64) -> *mut c_void;
    fn luma_mask_context_destroy(context: *mut c_void);
    fn luma_mask_context_error() -> *const c_char;
    fn luma_mask_render(
        context: *mut c_void,
        rgba: *const f32,
        width: u32,
        rows: u32,
        parameters: *const Params,
        proof: *const f64,
        peak: f64,
        mask: *mut u8,
    ) -> c_int;
}

struct Context(NonNull<c_void>);
// SAFETY: the included C++ context is immutable after creation and its error
// string is thread-local. Every scoped user joins before the owner can drop.
unsafe impl Sync for Context {}
impl Drop for Context {
    fn drop(&mut self) {
        // SAFETY: this is the sole owner; all borrowed strip calls have joined.
        unsafe { luma_mask_context_destroy(self.0.as_ptr()) };
    }
}
fn bridge_error() -> String {
    // SAFETY: copy the C++ thread-local NUL-terminated error on the same thread.
    let pointer = unsafe { luma_mask_context_error() };
    if pointer.is_null() {
        "The C++ mask bridge returned no error text.".to_owned()
    } else {
        unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
    }
}
fn integer(raw: &[u8; REQUEST_BYTES], at: usize) -> u32 {
    u32::from_le_bytes(raw[at..at + 4].try_into().unwrap())
}
fn wide(raw: &[u8; REQUEST_BYTES], at: usize) -> u64 {
    u64::from_le_bytes(raw[at..at + 8].try_into().unwrap())
}
fn number(raw: &[u8; REQUEST_BYTES], at: usize) -> f64 {
    f64::from_le_bytes(raw[at..at + 8].try_into().unwrap())
}
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino() && a.len() == b.len()
        && a.mtime() == b.mtime() && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime() && a.ctime_nsec() == b.ctime_nsec()
}

struct Request {
    raw: [u8; REQUEST_BYTES],
    width: u32,
    height: u32,
    source_bytes: u64,
    aces: [f64; 9],
    proof: [f64; 9],
    peak: f64,
    parameters: Params,
}
impl Request {
    fn open(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        if !path.is_absolute() {
            return Err("Expected an absolute owned mask request path.".into());
        }
        // Linux O_NOFOLLOW | O_NONBLOCK: reject links and inspect special files
        // without blocking on an untrusted FIFO before the regular-file check.
        let mut file = OpenOptions::new().read(true).custom_flags(0o400000 | 0o4000).open(path)?;
        let initial = file.metadata()?;
        if !initial.is_file() || initial.len() != REQUEST_BYTES as u64 {
            return Err("Mask request must be a regular file of exactly 416 bytes.".into());
        }
        let mut raw = [0; REQUEST_BYTES];
        file.read_exact(&mut raw)?;
        let mut extra = [0];
        if file.read(&mut extra)? != 0 || !same_file(&initial, &file.metadata()?) {
            return Err("The immutable mask request changed during its bounded read.".into());
        }
        let named = fs::symlink_metadata(path)?;
        if !named.is_file() || !same_file(&initial, &named) {
            return Err("The named mask request identity changed during its bounded read.".into());
        }
        // Reject a stale/wrong controller capability before context creation,
        // strip allocation or the first output byte. A nonzero hash is not proof
        // that this actual executable implements the requested arithmetic.
        if raw[384..416] != ARITHMETIC_SHA256 {
            return Err("Native mask arithmetic identity does not match this executable.".into());
        }
        let width = integer(&raw, 16);
        let height = integer(&raw, 20);
        let source_bytes = u64::from(width).checked_mul(u64::from(height))
            .and_then(|pixels| pixels.checked_mul(16)).ok_or("Mask source geometry overflow.")?;
        let flags = integer(&raw, 12);
        if &raw[..8] != b"MASKCPU1" || integer(&raw, 8) != 1 || flags & !KNOWN_FLAGS != 0
            || width == 0 || height == 0 || width > 32768 || height > 32768
            || integer(&raw, 24) != STRIP_ROWS || integer(&raw, 28) != 0
            || source_bytes > SOURCE_LIMIT || wide(&raw, 32) != source_bytes
            || raw[40..72].iter().all(|&value| value == 0)
            || raw[72..104].iter().all(|&value| value == 0)
        {
            return Err("Invalid bounded mask request identity, flags or geometry.".into());
        }
        let edits: [f64; 6] = std::array::from_fn(|index| number(&raw, 104 + index * 8));
        let wb: [f64; 9] = std::array::from_fn(|index| number(&raw, 152 + index * 8));
        let aces: [f64; 9] = std::array::from_fn(|index| number(&raw, 224 + index * 8));
        let proof: [f64; 9] = std::array::from_fn(|index| number(&raw, 296 + index * 8));
        let peak = number(&raw, 368);
        let headroom = number(&raw, 376);
        if wb.iter().chain(aces.iter()).chain(proof.iter()).any(|value| !value.is_finite() || value.abs() > 1e6)
            || edits.iter().enumerate().any(|(index, value)| !value.is_finite()
                || value.abs() > if index == 0 { 5.0 } else { 100.0 })
            || !peak.is_finite() || !(1.0..=100.0).contains(&peak)
            || !headroom.is_finite()
            || (flags & 16 != 0 && !(1.0..=100.0).contains(&headroom))
            || (flags & 16 == 0 && headroom != 0.0)
        {
            return Err("Invalid frozen mask arithmetic parameters.".into());
        }
        let parameters = Params {
            exposure: edits[0], contrast: edits[1], highlights: edits[2],
            shadows: edits[3], whites: edits[4], blacks: edits[5], wb, headroom, flags,
        };
        Ok(Self { raw, width, height, source_bytes, aces, proof, peak, parameters })
    }
}

fn render(context: &Context, request: &Request, input: &[f32], rows: u32, output: &mut [u8]) -> Result<(), String> {
    let pixels = request.width as usize * rows as usize;
    if input.len() != pixels * 4 || output.len() != pixels || rows == 0 || rows > STRIP_ROWS {
        return Err("The C++ mask call escaped its exact owned strip spans.".to_owned());
    }
    // SAFETY: input is aligned, immutable and fully validated; output is a tight
    // disjoint exclusive span. Context, parameters and matrices outlive this call.
    let result = unsafe { luma_mask_render(
        context.0.as_ptr(), input.as_ptr(), request.width, rows, &request.parameters,
        request.proof.as_ptr(), request.peak, output.as_mut_ptr(),
    ) };
    if result == 1 { Ok(()) } else { Err(bridge_error()) }
}

// THREADS counts total participants including this caller, never eight workers
// plus a ninth coordinator. Every handle is explicitly joined on every outcome.
fn render_strip(context: &Context, request: &Request, input: &[f32], rows: u32,
    output: &mut [u8], threads: usize) -> Result<usize, String> {
    if threads == 1 || rows == 1 {
        render(context, request, input, rows, output)?;
        return Ok(0);
    }
    let chunk_rows = (rows as usize).div_ceil(threads);
    let chunk_bytes = chunk_rows * request.width as usize;
    thread::scope(|scope| {
        let mut parts = output.chunks_mut(chunk_bytes).enumerate();
        let (_, caller) = parts.next().ok_or("Missing caller mask span.")?;
        let mut workers = Vec::with_capacity(threads - 1);
        let mut failure: Option<String> = None;
        for (index, mask) in parts {
            let row_start = index * chunk_rows;
            let count = mask.len() / request.width as usize;
            let first = row_start * request.width as usize * 4;
            let rgba = &input[first..first + count * request.width as usize * 4];
            let worker = thread::Builder::new().name(format!("mask-strip-{index}"))
                .stack_size(WORKER_STACK_BYTES)
                .spawn_scoped(scope, move || render(context, request, rgba, count as u32, mask));
            match worker {
                Ok(handle) => workers.push(handle),
                Err(error) => { failure = Some(format!("Cannot spawn mask participant: {error}")); break; }
            }
        }
        let spawned = workers.len();
        if failure.is_none() {
            let count = caller.len() / request.width as usize;
            let result = catch_unwind(AssertUnwindSafe(|| render(
                context, request, &input[..count * request.width as usize * 4], count as u32, caller,
            )));
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => failure = Some(error),
                Err(_) => failure = Some("The caller mask participant panicked.".to_owned()),
            }
        }
        for worker in workers {
            let result = match worker.join() {
                Ok(result) => result,
                Err(_) => Err("A scoped mask participant panicked.".to_owned()),
            };
            if let Err(error) = result {
                if failure.is_none() { failure = Some(error); }
            }
        }
        match failure { Some(error) => Err(error), None => Ok(spawned) }
    })
}

pub fn run(arguments: &[std::ffi::OsString]) -> Result<(), Box<dyn std::error::Error>> {
    if arguments.len() != 3 {
        return Err("Usage: luma-cpu-render --mask-v1 ABS_REQUEST THREADS(1|4|8); exact F32 stdin, binary stdout.".into());
    }
    let threads = match arguments[2].to_str() {
        Some("1") => 1, Some("4") => 4, Some("8") => 8,
        _ => return Err("Total mask participants must be exactly 1, 4 or 8.".into()),
    };
    if u32::from_ne_bytes([1, 0, 0, 0]) != 1 {
        return Err("The source F32 storage requires a little-endian host.".into());
    }
    let request = Request::open(Path::new(&arguments[1]))?;
    let preparation = Instant::now();
    // SAFETY: both nine-element arrays are immutable and copied by C++ creation.
    // The existing complete SDR/content factory is reused, including its tables.
    let context = Context(NonNull::new(unsafe {
        luma_mask_context_create(request.aces.as_ptr(), request.proof.as_ptr())
    }).ok_or_else(bridge_error)?);
    let strip_pixels = request.width as usize * request.height.min(STRIP_ROWS) as usize;
    let mut input = Vec::new();
    input.try_reserve_exact(strip_pixels * 4)?;
    input.resize(strip_pixels * 4, 0.0f32);
    let mut mask = Vec::new();
    mask.try_reserve_exact(strip_pixels)?;
    mask.resize(strip_pixels, 0u8);
    let stdin = io::stdin();
    let mut source = stdin.lock();
    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(WRITER_BYTES, stdout.lock());
    let preparation_ms = preparation.elapsed().as_secs_f64() * 1000.0;
    let mut read_ms = 0.0;
    let mut compute_ms = 0.0;
    let mut write_ms = 0.0;
    let mut strips = 0u32;
    let mut pixels = 0u64;
    let mut peak_worker_stack = 0usize;
    let base_owned = input.capacity() * 4 + mask.capacity() + output.capacity() + REQUEST_BYTES;
    let mut peak_owned = base_owned;
    let timer = Instant::now();
    output.write_all(b"MASKOUT1")?;
    output.write_all(&(REQUEST_BYTES as u32).to_le_bytes())?;
    output.write_all(&request.raw)?;
    output.write_all(&(threads as u32).to_le_bytes())?;
    output.flush()?;
    write_ms += timer.elapsed().as_secs_f64() * 1000.0;
    for row in (0..request.height).step_by(STRIP_ROWS as usize) {
        let rows = (request.height - row).min(STRIP_ROWS);
        let count = request.width as usize * rows as usize;
        let rgba = &mut input[..count * 4];
        let timer = Instant::now();
        // SAFETY: f32 accepts every bit pattern, storage is aligned and exclusive,
        // and no C++ call or worker borrows it until this exact read/validation ends.
        let bytes = unsafe { std::slice::from_raw_parts_mut(rgba.as_mut_ptr().cast::<u8>(), rgba.len() * 4) };
        source.read_exact(bytes)?;
        for pixel in rgba.chunks_exact(4) {
            if pixel.iter().any(|value| !value.is_finite()) || !(0.0..=1.0).contains(&pixel[3]) {
                return Err("Invalid source RGBA, including RGB at alpha zero.".into());
            }
        }
        read_ms += timer.elapsed().as_secs_f64() * 1000.0;
        let timer = Instant::now();
        let spawned = render_strip(&context, &request, rgba, rows, &mut mask[..count], threads)?;
        if mask[..count].iter().any(|&bits| bits > 15) {
            return Err("The mask kernel emitted bits outside the four-bit contract.".into());
        }
        compute_ms += timer.elapsed().as_secs_f64() * 1000.0;
        peak_worker_stack = peak_worker_stack.max(spawned * WORKER_STACK_BYTES);
        // Known strip/stdio/request buffers plus requested spawned-worker stacks.
        // Excludes C++ immutable tables, runtime, main stack and OS guard pages;
        // this is a conservative managed-buffer reservation, not process RSS.
        peak_owned = peak_owned.max(base_owned + spawned * WORKER_STACK_BYTES);
        let timer = Instant::now();
        output.write_all(b"STRP")?;
        for value in [row, rows, count as u32] { output.write_all(&value.to_le_bytes())?; }
        output.write_all(&mask[..count])?;
        output.flush()?;
        write_ms += timer.elapsed().as_secs_f64() * 1000.0;
        strips += 1;
        pixels += count as u64;
    }
    let timer = Instant::now();
    let mut excess = [0u8; 1];
    if source.read(&mut excess)? != 0 || pixels.checked_mul(16) != Some(request.source_bytes)
        || strips != request.height.div_ceil(STRIP_ROWS)
    {
        return Err("Source stdin was excessive or mask geometry was incomplete.".into());
    }
    read_ms += timer.elapsed().as_secs_f64() * 1000.0;
    // Real stdin EOF and all scoped joins precede the terminal record. The echoed
    // SHA bytes are identities only: the trusted parent authenticates its pinned
    // feed and accepts only complete stdout EOF plus actual successful child close.
    let mut terminal = [0u8; TERMINAL_BYTES];
    terminal[..8].copy_from_slice(b"MASKDONE");
    terminal[8..16].copy_from_slice(&pixels.to_le_bytes());
    terminal[16..20].copy_from_slice(&strips.to_le_bytes());
    // 20..24 remains the required zero reserved word.
    for (index, duration) in [preparation_ms, read_ms, compute_ms, write_ms].iter().enumerate() {
        terminal[24 + index * 8..32 + index * 8].copy_from_slice(&duration.to_le_bytes());
    }
    terminal[56..64].copy_from_slice(&(peak_owned as u64).to_le_bytes());
    terminal[64..72].copy_from_slice(&(peak_worker_stack as u64).to_le_bytes());
    output.write_all(&terminal)?;
    output.flush()?;
    Ok(())
}
