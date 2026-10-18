// Research-only service with the same little-endian frame protocol as pointwise.cpp.
use rayon::prelude::*;
use std::io::{self, Read, Write};
use std::time::Instant;

fn u32_at(header: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(header[offset..offset + 4].try_into().unwrap())
}
fn f64_at(header: &[u8], offset: usize) -> f64 {
    f64::from_le_bytes(header[offset..offset + 8].try_into().unwrap())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(target_endian = "little") { return Err("Little-endian host required.".into()); }
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() != 2 { return Err("Expected a bounded thread count.".into()); }
    let threads: usize = arguments[1].parse()?;
    if !(1..=8).contains(&threads) { return Err("Thread count must be from 1 to 8.".into()); }
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build()?;
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut data: Vec<f32> = Vec::new();
    loop {
        let mut header = [0_u8; 32];
        // A clean EOF is different from a partial header.
        if input.read(&mut header[..1])? == 0 { break; }
        input.read_exact(&mut header[1..])?;
        let width = u32_at(&header, 4) as usize;
        let height = u32_at(&header, 8) as usize;
        let ev = f64_at(&header, 16);
        let amount = f64_at(&header, 24);
        let length = width.checked_mul(height).and_then(|p| p.checked_mul(4)).ok_or("Frame size overflow.")?;
        if u32_at(&header, 0) != 0x31554d4c || width == 0 || height == 0 || width > 32768 || height > 32768 ||
            length > 128 * 1024 * 1024 / 4 || !ev.is_finite() || !(-5.0..=5.0).contains(&ev) ||
            !amount.is_finite() || !(-0.9..=1.0).contains(&amount) { return Err("Invalid research frame contract.".into()); }
        data.resize(length, 0.0);
        // SAFETY: data owns initialized contiguous f32 storage; its mutable lease is exclusive
        // and no Rayon task runs while the pipe accesses it. All f32 bit patterns are valid.
        let bytes = unsafe { std::slice::from_raw_parts_mut(data.as_mut_ptr().cast::<u8>(), length * 4) };
        input.read_exact(bytes)?;
        let start = Instant::now();
        let gain = ev.exp2();
        let valid = pool.install(|| data.par_chunks_mut(4).all(|pixel| {
            if !pixel.iter().all(|v| v.is_finite()) { return false; }
            for value in &mut pixel[..3] {
                *value = (f64::from(*value) * gain) as f32;
                let v = f64::from(*value);
                *value = (v + amount * v * v.abs() / (1.0 + v.abs())) as f32;
            }
            true
        }));
        if !valid { return Err("Nonfinite pixels.".into()); }
        header[..4].copy_from_slice(&0x31524d4c_u32.to_le_bytes());
        header[16..24].copy_from_slice(&(start.elapsed().as_nanos() as f64).to_le_bytes());
        header[24..32].copy_from_slice(&((data.capacity() * 4) as f64).to_le_bytes());
        output.write_all(&header)?;
        // SAFETY: all parallel mutable leases ended at pool.install; this is an immutable
        // view of exactly the initialized bytes, held until write_all completes.
        let bytes = unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), length * 4) };
        output.write_all(bytes)?;
        output.flush()?;
    }
    Ok(())
}
