mod mask;
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("This research host currently supports Linux x86_64 only.");

use std::ffi::{c_char, c_int, c_void, CStr};
use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::ptr::NonNull;
use std::time::Instant;

const REQUEST_BYTES: usize = 400;
const SOURCE_LIMIT: u64 = 512 * 1024 * 1024;
const WORKER_STACK_BYTES: usize = 512 * 1024;

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

extern "C" {
    fn luma_cpu_create(aces: *const f64, srgb: *const f64) -> *mut c_void;
    fn luma_cpu_render(
        context: *mut c_void, input: *const f32, source_width: u32, source_height: u32,
        source_row: u32, source_rows: u32, output_width: u32, output_height: u32,
        output_row: u32, output_rows: u32, parameters: *const Params,
        after: *mut u8, before: *mut u8,
    ) -> c_int;
    fn luma_cpu_destroy(context: *mut c_void);
    fn luma_cpu_error() -> *const c_char;
}

struct Context(NonNull<c_void>);
// SAFETY: the C++ context owns immutable prepared tables; rendering has no shared
// mutation and its error string is thread-local. Scoped workers join before Drop.
unsafe impl Sync for Context {}
impl Drop for Context {
    fn drop(&mut self) {
        unsafe { luma_cpu_destroy(self.0.as_ptr()) };
    }
}

fn bridge_error() -> String {
    // SAFETY: a live thread-local NUL-terminated C++ error copied on this thread.
    unsafe { CStr::from_ptr(luma_cpu_error()) }.to_string_lossy().into_owned()
}
fn integer(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn wide(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}
fn number(bytes: &[u8], at: usize) -> f64 {
    f64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}
fn regular(path: &Path, expected: u64) -> Result<File, Box<dyn std::error::Error>> {
    if !path.is_absolute() { return Err("Expected an absolute owned input path.".into()); }
    let file = OpenOptions::new().read(true).custom_flags(0o400000).open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() != expected {
        return Err("Input is not a regular file of the exact declared length.".into());
    }
    Ok(file)
}

enum Source {
    File { file: File, initial: std::fs::Metadata },
    Stdin(io::Stdin),
}
impl Read for Source {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::File { file, .. } => file.read(bytes),
            Self::Stdin(input) => input.read(bytes),
        }
    }
}
impl Source {
    fn unchanged(&self) -> io::Result<bool> {
        match self {
            Self::File { file, initial } => {
                let current = file.metadata()?;
                Ok(current.len() == initial.len() && current.modified()? == initial.modified()?)
            }
            // Main authenticates the leased bytes it feeds. Native success alone
            // never grants source authenticity, including in this stdin mode.
            Self::Stdin(_) => Ok(true),
        }
    }
}

struct Request {
    raw: [u8; REQUEST_BYTES],
    width: u32,
    height: u32,
    output_width: u32,
    output_height: u32,
    aces: [f64; 9],
    srgb: [f64; 9],
    parameters: Params,
}
impl Request {
    fn open(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let mut raw = [0; REQUEST_BYTES];
        regular(path, REQUEST_BYTES as u64)?.read_exact(&mut raw)?;
        let (width, height, output_width, output_height) = (
            integer(&raw, 16), integer(&raw, 20), integer(&raw, 24), integer(&raw, 28),
        );
        let source_bytes = u64::from(width) * u64::from(height) * 16;
        let flags = integer(&raw, 12);
        if &raw[..8] != b"LUMACPU1" || integer(&raw, 8) != 1 || flags & !31 != 0
            || width == 0 || height == 0 || width > 32768 || height > 32768
            || source_bytes > SOURCE_LIMIT || source_bytes != wide(&raw, 120)
            || raw[56..88].iter().all(|&n| n == 0) || raw[88..120].iter().all(|&n| n == 0)
            || [wide(&raw, 32), wide(&raw, 40), wide(&raw, 48)].iter().any(|&n| n > 9_007_199_254_740_991)
        { return Err("Invalid CPU renderer request contract.".into()); }
        let scale = 1024.0 / f64::from(width.max(height));
        let draft_width = (f64::from(width) * scale).round().max(1.0) as u32;
        let draft_height = (f64::from(height) * scale).round().max(1.0) as u32;
        if (output_width, output_height) != (width, height)
            && !(width.max(height) > 1024 && (output_width, output_height) == (draft_width, draft_height))
        { return Err("Output must retain full geometry or the existing 1024-pixel draft geometry.".into()); }
        let aces = std::array::from_fn(|i| number(&raw, 128 + i * 8));
        let srgb = std::array::from_fn(|i| number(&raw, 200 + i * 8));
        let edits: [f64; 6] = std::array::from_fn(|i| number(&raw, 272 + i * 8));
        let wb = std::array::from_fn(|i| number(&raw, 320 + i * 8));
        let headroom = number(&raw, 392);
        if aces.iter().chain(srgb.iter()).chain(wb.iter()).any(|v| !v.is_finite() || v.abs() > 1e6)
            || edits.iter().enumerate().any(|(i, v)| !v.is_finite() || v.abs() > if i == 0 { 5.0 } else { 100.0 })
            || !headroom.is_finite() || (flags & 16 != 0 && !(1.0..=100.0).contains(&headroom))
            || (flags & 8 != 0 && (flags & 1 != 0 || edits.iter().any(|&v| v != 0.0)))
        { return Err("Invalid frozen CPU arithmetic parameters.".into()); }
        let parameters = Params {
            exposure: edits[0], contrast: edits[1], highlights: edits[2], shadows: edits[3],
            whites: edits[4], blacks: edits[5], wb, headroom, flags,
        };
        Ok(Self { raw, width, height, output_width, output_height, aces, srgb, parameters })
    }
}

#[allow(clippy::too_many_arguments)]
fn render(
    context: &Context, request: &Request, input: &[f32], row: u32, rows: u32,
    output_row: u32, output_rows: u32, after: &mut [u8], before: &mut [u8],
) -> Result<(), String> {
    // SAFETY: all spans are exact bounded strip allocations, the C++ routine
    // validates source/output row mapping, and context/parameters outlive this call.
    let result = unsafe { luma_cpu_render(
        context.0.as_ptr(), input.as_ptr(), request.width, request.height, row, rows,
        request.output_width, request.output_height, output_row, output_rows,
        &request.parameters, after.as_mut_ptr(), before.as_mut_ptr(),
    ) };
    if result == 0 { Err(bridge_error()) } else { Ok(()) }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args_os().collect();
    if arguments.len() == 2 && arguments[1] == "--capabilities" {
        let mut output = io::stdout().lock();
        output.write_all(include_bytes!(env!("LUMA_CPU_CAPABILITIES")))?;
        output.flush()?;
        return Ok(());
    }
    if arguments.get(1).is_some_and(|value| value == "--mask-v1") {
        return mask::run(&arguments[1..]);
    }
    if arguments.len() != 4 {
        return Err("Usage: luma-cpu-render ABS_REQUEST ABS_SOURCE|- THREADS(1|4|8); binary stdout.".into());
    }
    let threads: usize = arguments[3].to_str().ok_or("Invalid worker count.")?.parse()?;
    if ![1, 4, 8].contains(&threads) { return Err("Worker count must be 1, 4 or 8.".into()); }
    let request = Request::open(Path::new(&arguments[1]))?;
    let mut source = if arguments[2] == "-" {
        Source::Stdin(io::stdin())
    } else {
        let file = regular(Path::new(&arguments[2]), wide(&request.raw, 120))?;
        let initial = file.metadata()?;
        Source::File { file, initial }
    };
    let started = Instant::now();
    let context = Context(NonNull::new(unsafe { luma_cpu_create(request.aces.as_ptr(), request.srgb.as_ptr()) })
        .ok_or_else(bridge_error)?);
    let preparation_ms = started.elapsed().as_secs_f64() * 1000.0;
    let strip_floats = request.width as usize * request.height.min(64) as usize * 4;
    let mut input = vec![0.0f32; strip_floats];
    let mut after = Vec::new();
    let mut before = Vec::new();
    let mut next_row = 0u32;
    let mut rendered_strips = 0u32;
    let mut read_ms = 0.0;
    let mut render_ms = 0.0;
    let mut output_ms = 0.0;
    let mut peak_owned_bytes = 0usize;
    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(64 * 1024, stdout.lock());
    output.write_all(b"LUMARGB1")?;
    output.write_all(&(REQUEST_BYTES as u32).to_le_bytes())?;
    output.write_all(&request.raw)?;
    output.write_all(&(threads as u32).to_le_bytes())?;
    for row in (0..request.height).step_by(64) {
        let rows = (request.height - row).min(64);
        let input = &mut input[..request.width as usize * rows as usize * 4];
        let timer = Instant::now();
        // SAFETY: f32 accepts every bit pattern and input is aligned, exclusively
        // owned, and not borrowed by C++ until this exact little-endian read ends.
        let bytes = unsafe { std::slice::from_raw_parts_mut(input.as_mut_ptr().cast::<u8>(), input.len() * 4) };
        source.read_exact(bytes)?;
        for pixel in input.chunks_exact(4) {
            if pixel.iter().any(|value| !value.is_finite()) || !(0.0..=1.0).contains(&pixel[3]) {
                return Err("Invalid F32 source sample, including an unsampled draft pixel.".into());
            }
        }
        read_ms += timer.elapsed().as_secs_f64() * 1000.0;
        let first_row = next_row;
        while next_row < request.output_height {
            let y = ((f64::from(next_row) + 0.5) * f64::from(request.height) / f64::from(request.output_height)).floor() as u32;
            if y >= row + rows { break; }
            if y < row { return Err("Output sample escaped its verified source strip.".into()); }
            next_row += 1;
        }
        let output_rows = next_row - first_row;
        if output_rows == 0 { continue; }
        let output_bytes = request.output_width as usize * output_rows as usize * 4;
        after.resize(output_bytes, 0);
        before.resize(output_bytes, 0);
        peak_owned_bytes = peak_owned_bytes.max(strip_floats * 4 + after.capacity() + before.capacity() + threads * WORKER_STACK_BYTES + 64 * 1024);
        let timer = Instant::now();
        if threads == 1 {
            render(&context, &request, input, row, rows, first_row, output_rows, &mut after, &mut before)?;
        } else {
            let chunk_rows = (output_rows as usize).div_ceil(threads);
            let chunk_bytes = chunk_rows * request.output_width as usize * 4;
            std::thread::scope(|scope| -> Result<(), String> {
                let mut workers = Vec::new();
                for (index, (a, b)) in after.chunks_mut(chunk_bytes).zip(before.chunks_mut(chunk_bytes)).enumerate() {
                    let count = (a.len() / (request.output_width as usize * 4)) as u32;
                    let context = &context;
                    let request = &request;
                    let input = &*input;
                    workers.push(std::thread::Builder::new().name(format!("cpu-strip-{index}"))
                        .stack_size(WORKER_STACK_BYTES)
                        .spawn_scoped(scope, move || render(context, request, input, row, rows,
                            first_row + (index * chunk_rows) as u32, count, a, b))
                        .map_err(|e| e.to_string())?);
                }
                for worker in workers { worker.join().map_err(|_| "CPU worker panicked.".to_string())??; }
                Ok(())
            })?;
        }
        render_ms += timer.elapsed().as_secs_f64() * 1000.0;
        let timer = Instant::now();
        output.write_all(b"LUMAROW1")?;
        for value in [first_row, output_rows, output_bytes as u32, 0] { output.write_all(&value.to_le_bytes())?; }
        output.write_all(&after)?;
        output.write_all(&before)?;
        output.flush()?;
        output_ms += timer.elapsed().as_secs_f64() * 1000.0;
        rendered_strips += 1;
    }
    let mut trailing = [0u8; 1];
    if source.read(&mut trailing)? != 0 || next_row != request.output_height
        || !source.unchanged()?
    { return Err("The immutable input changed or output was incomplete.".into()); }
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let trailer = format!("{{\"implementation\":\"float64-ctl-cpu-strip-v1\",\"threads\":{threads},\"threadStrategy\":\"scoped-per-strip\",\"renderedStrips\":{rendered_strips},\"preparationMs\":{preparation_ms},\"readMs\":{read_ms},\"renderMs\":{render_ms},\"outputMs\":{output_ms},\"elapsedMs\":{elapsed_ms},\"plannedStripAndWorkerBytes\":{peak_owned_bytes},\"sourceHashVerifiedByChild\":false,\"productionIntegration\":false}}");
    output.write_all(b"LUMAEND1")?;
    output.write_all(&(trailer.len() as u32).to_le_bytes())?;
    output.write_all(trailer.as_bytes())?;
    output.flush()?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
