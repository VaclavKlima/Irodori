#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("The native codec currently targets Linux x86_64 only.");

use std::env;
use std::ffi::{c_char, c_int, c_void, CStr, OsStr};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::time::Instant;

const SOURCE_LIMIT: u64 = 512 * 1024 * 1024;
const JPEG_LIMIT: u64 = 256 * 1024 * 1024;
const PROCESS_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

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
    fn irodori_encode(
        half: *mut c_void,
        width: u32,
        height: u32,
        jpeg: *mut c_void,
        length: u32,
        quality: c_int,
        headroom: f32,
    ) -> c_int;
    fn irodori_output() -> *mut c_void;
    fn irodori_size() -> u32;
    fn irodori_error() -> *const c_char;
    fn irodori_release();
    fn irodori_codec_probe(width: u32, height: u32) -> c_int;
    fn irodori_codec_peak_bytes() -> u64;
}

// Only immutable main-owned job scratch inputs enter this process. Each mapping
// owns its lifetime; the codec finishes before either mapping is released.
struct Input {
    address: NonNull<c_void>,
    length: usize,
}

impl Input {
    fn open(
        path: &Path,
        maximum: u64,
        expected: Option<u64>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if !path.is_absolute() {
            return Err("Native codec paths must be absolute.".into());
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(0o400000)
            .open(path)?;
        let metadata = file.metadata()?;
        let length = metadata.len();
        if !metadata.is_file()
            || length == 0
            || length > maximum
            || expected.is_some_and(|value| length != value)
        {
            return Err("Invalid native encoder input length.".into());
        }
        let length = usize::try_from(length)?;
        // SAFETY: Linux x86_64 mmap ABI; the file is a validated regular file,
        // length is bounded and nonzero, offset is zero, PROT_READ/MAP_PRIVATE.
        // The owned input is immutable until this job exits.
        let address = unsafe { mmap(std::ptr::null_mut(), length, 1, 2, file.as_raw_fd(), 0) };
        if address as isize == -1 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(Self {
            address: NonNull::new(address).ok_or("Native encoder mapping failed.")?,
            length,
        })
    }
}

impl Drop for Input {
    fn drop(&mut self) {
        // SAFETY: exactly the live mapping created by Input::open; no codec call
        // or borrowed output remains active when the input owner is dropped.
        unsafe {
            munmap(self.address.as_ptr(), self.length);
        }
    }
}

struct Codec;
impl Drop for Codec {
    fn drop(&mut self) {
        // SAFETY: this single-request process is the sole bridge owner. All
        // borrowed output is consumed before this guard releases the encoder.
        unsafe {
            irodori_release();
        }
    }
}

struct Output {
    path: PathBuf,
    file: File,
    complete: bool,
}

impl Drop for Output {
    fn drop(&mut self) {
        if !self.complete {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn integer(value: &OsStr) -> Result<u32, Box<dyn std::error::Error>> {
    let text = value.to_str().ok_or("Invalid native encoder argument.")?;
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Invalid native encoder argument.".into());
    }
    Ok(text.parse()?)
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = env::args_os().collect();
    if arguments.len() != 8 {
        return Err("Expected dimensions, quality, headroom and three owned paths.".into());
    }
    let width = integer(&arguments[1])?;
    let height = integer(&arguments[2])?;
    let quality = integer(&arguments[3])?;
    let headroom: f32 = arguments[4]
        .to_str()
        .ok_or("Invalid HDR headroom.")?
        .parse()?;
    let pixels = u64::from(width) * u64::from(height);
    if width == 0
        || height == 0
        || width > 32768
        || height > 32768
        || !(1..=100).contains(&quality)
        || pixels * 16 > SOURCE_LIMIT
        || !headroom.is_finite()
        || !(1.0..=10.0).contains(&headroom)
    {
        return Err("Unsupported native encoder allocation or dimensions.".into());
    }
    let half = Input::open(Path::new(&arguments[5]), SOURCE_LIMIT, Some(pixels * 8))?;
    let jpeg = Input::open(Path::new(&arguments[6]), JPEG_LIMIT, None)?;
    if pixels * 56 + jpeg.length as u64 * 3 + 128 * 1024 * 1024 > PROCESS_LIMIT {
        return Err("HDR JPEG exceeds the supported encoder allocation limit.".into());
    }
    let output_path = PathBuf::from(&arguments[7]);
    if !output_path.is_absolute() {
        return Err("Native codec paths must be absolute.".into());
    }
    let _codec = Codec;
    let started = Instant::now();
    // SAFETY: each mapping owns the exact validated input length. The unchanged
    // bridge catches C++ exceptions, joins all codec work, and reads these inputs
    // synchronously. There are no concurrent calls to its global encoder state.
    if unsafe {
        irodori_encode(
            half.address.as_ptr(),
            width,
            height,
            jpeg.address.as_ptr(),
            jpeg.length as u32,
            quality as c_int,
            headroom,
        )
    } == 0
    {
        // SAFETY: the bridge returns a live NUL-terminated error string and the
        // single request cannot mutate it during this copy.
        let error = unsafe { CStr::from_ptr(irodori_error()) }
            .to_string_lossy()
            .into_owned();
        return Err(error.into());
    }
    let encode_ms = started.elapsed().as_secs_f64() * 1000.0;
    // SAFETY: the live stream belongs to _codec; probing neither releases nor
    // mutates it, and the shim catches every C++ exception.
    if unsafe { irodori_codec_probe(width, height) } == 0 {
        return Err("Invalid native HDR JPEG rendition geometry.".into());
    }
    // SAFETY: the bridge owns a live output buffer until _codec is dropped.
    let (address, length) = unsafe { (irodori_output(), irodori_size() as usize) };
    if address.is_null() || length == 0 || length as u64 > PROCESS_LIMIT {
        return Err("Native encoder returned no image.".into());
    }
    // SAFETY: the checked output span is immutable and remains owned by _codec.
    let bytes = unsafe { std::slice::from_raw_parts(address.cast::<u8>(), length) };
    let mut output = Output {
        file: OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&output_path)?,
        path: output_path,
        complete: false,
    };
    output.file.write_all(bytes)?;
    // SAFETY: the shim returns Linux process peak RSS in bytes, without sharing
    // ownership or exposing native structures across the language boundary.
    let peak_bytes = unsafe { irodori_codec_peak_bytes() };
    if peak_bytes == 0 || peak_bytes > PROCESS_LIMIT {
        return Err("Native HDR JPEG exceeded the 2 GiB process memory limit.".into());
    }
    output.complete = true;
    println!("{{\"width\":{width},\"height\":{height},\"peakBytes\":{peak_bytes},\"encodeMs\":{encode_ms},\"implementation\":\"rust-ultrahdr-v1\"}}");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
