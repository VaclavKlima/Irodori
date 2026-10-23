// Sony ARW2 arithmetic adapted from pinned LibRaw 0.22.1, decoders_dcraw.cpp.
// Copyright 2019-2025 LibRaw LLC; dcraw Copyright 1997-2018 Dave Coffin.
// CDDL-1.0 source-availability route; preserve licenses/ and the exact upstream source.
// No RAW metadata parser, normalization, orientation, demosaic or image policy lives here.
use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::thread;
use std::time::Instant;

#[repr(C)]
#[derive(Default)]
pub struct RowsReport {
    elapsed_ms: f64,
    rows: u64,
    blocks: u64,
    samples: u64,
    participants: u32,
    observed_threads: u32,
    error_code: u32,
}
const _: [(); 48] = [(); std::mem::size_of::<RowsReport>()];

fn observe_threads(maximum: &AtomicU32) -> Result<(), ()> {
    let status = fs::read_to_string("/proc/self/status").map_err(|_| ())?;
    let count: u32 = status.lines().find_map(|line| line.strip_prefix("Threads:"))
        .ok_or(())?.trim().parse().map_err(|_| ())?;
    if count == 0 || count > 8 { return Err(()); }
    maximum.fetch_max(count, Ordering::Relaxed);
    Ok(())
}

fn get2(row: &[u8], offset: usize, order: u32) -> Result<u16, ()> {
    // Upstream allocates raw_width+1 zeroed bytes. Preserve its row-local zero sentinel,
    // including for the final block; never borrow a byte from the following row instead.
    let byte = |index: usize| -> Result<u8, ()> {
        if index == row.len() { Ok(0) } else { row.get(index).copied().ok_or(()) }
    };
    let first = byte(offset)?;
    let second = byte(offset.checked_add(1).ok_or(())?)?;
    Ok(if order == 0x4949 {
        u16::from_le_bytes([first, second])
    } else {
        u16::from_be_bytes([first, second])
    })
}

fn decode_band(input: &[u8], output: &mut [u16], width: usize, order: u32,
    curve: &[u16], stop: &AtomicBool, observed: &AtomicU32) -> Result<(u64, u64, u64), ()> {
    observe_threads(observed)?;
    let mut counts = (0, 0, 0);
    for (row, target) in input.chunks_exact(width).zip(output.chunks_exact_mut(width)) {
        if stop.load(Ordering::Relaxed) { return Err(()); }
        // Equivalent to upstream's even/odd col traversal when raw_width is divisible by32.
        for pair in 0..width / 32 {
            for parity in 0..2 {
                let at = pair * 32 + parity * 16;
                let bytes: [u8; 4] = row.get(at..at + 4).ok_or(())?.try_into().map_err(|_| ())?;
                let value = if order == 0x4949 { u32::from_le_bytes(bytes) } else { u32::from_be_bytes(bytes) };
                let maximum = (value & 0x7ff) as i32;
                let minimum = ((value >> 11) & 0x7ff) as i32;
                let imax = ((value >> 22) & 15) as usize;
                let imin = ((value >> 26) & 15) as usize;
                let mut shift = 0;
                while shift < 4 && (0x80 << shift) <= maximum - minimum { shift += 1; }
                let mut bit = 30;
                for index in 0..16 {
                    let pixel = if index == imax { maximum } else if index == imin { minimum } else {
                        let packed = get2(row, at + (bit >> 3), order)?;
                        let decoded = ((((packed >> (bit & 7)) & 0x7f) as i32) << shift) + minimum;
                        bit += 7;
                        decoded.min(0x7ff)
                    };
                    let lookup = usize::try_from(pixel).map_err(|_| ())?.checked_mul(2).ok_or(())?;
                    *target.get_mut(pair * 32 + parity + index * 2).ok_or(())? = *curve.get(lookup).ok_or(())?;
                }
                counts.1 += 1;
                counts.2 += 16;
            }
        }
        counts.0 += 1;
    }
    Ok(counts)
}

fn decode(input: &[u8], output: &mut [u16], width: usize, height: usize, order: u32,
    curve: &[u16], requested: usize, report: &mut RowsReport) -> Result<(), ()> {
    let participants = requested.min(height);
    let stop = AtomicBool::new(false);
    let observed = AtomicU32::new(0);
    let result = thread::scope(|scope| {
        let mut handles = Vec::with_capacity(participants.saturating_sub(1));
        let mut remaining = output;
        let mut start_row = 0;
        let mut failure = false;
        for worker in 0..participants - 1 {
            let rows = height / participants + usize::from(worker < height % participants);
            let (band, rest) = remaining.split_at_mut(rows * width);
            remaining = rest;
            let compressed = &input[start_row * width..(start_row + rows) * width];
            start_row += rows;
            let stop_ref = &stop;
            let observed_ref = &observed;
            match thread::Builder::new().name(format!("sony-row-{worker}"))
                .stack_size(1024 * 1024).spawn_scoped(scope, move || {
                    let result = decode_band(compressed, band, width, order, curve, stop_ref, observed_ref);
                    if result.is_err() { stop_ref.store(true, Ordering::Relaxed); }
                    result
                }) {
                Ok(handle) => handles.push(handle),
                Err(_) => { stop.store(true, Ordering::Relaxed); failure = true; break; }
            }
        }
        report.participants = (handles.len() + 1) as u32;
        let main_result = if failure { Err(()) } else {
            decode_band(&input[start_row * width..], remaining, width, order, curve, &stop, &observed)
        };
        if main_result.is_err() { stop.store(true, Ordering::Relaxed); }
        let mut counts = main_result.unwrap_or((0, 0, 0));
        failure |= main_result.is_err();
        // Every spawned task joins even after a malformed row, spawn failure or panic.
        for handle in handles {
            match handle.join() {
                Ok(Ok(values)) => { counts.0 += values.0; counts.1 += values.1; counts.2 += values.2; }
                _ => { failure = true; stop.store(true, Ordering::Relaxed); }
            }
        }
        report.rows = counts.0;
        report.blocks = counts.1;
        report.samples = counts.2;
        if failure { Err(()) } else { Ok(()) }
    });
    report.observed_threads = observed.load(Ordering::Relaxed);
    result?;
    if report.rows != height as u64 || report.samples != (width * height) as u64
        || report.blocks != (width / 16 * height) as u64 || report.participants > 8
        || report.observed_threads == 0 || report.observed_threads > 8 { return Err(()); }
    Ok(())
}

#[no_mangle]
pub unsafe extern "C" fn luma_rows_decode(input: *const u8, input_length: usize,
    width: usize, height: usize, order: u32, curve: *const u16, curve_length: usize,
    output: *mut u16, output_length: usize, threads: u32, report: *mut RowsReport) -> i32 {
    if report.is_null() { return -1; }
    let started = Instant::now();
    // SAFETY: the C++ caller supplies one aligned report owner for this synchronous call.
    let report = unsafe { &mut *report };
    *report = RowsReport::default();
    let count = width.checked_mul(height);
    if input.is_null() || curve.is_null() || output.is_null() || width == 0 || height == 0
        || width % 32 != 0 || width > 32768 || height > 32768
        || count != Some(input_length) || count != Some(output_length)
        || output_length > 128 * 1024 * 1024 / 2 || curve_length != 65536
        || (curve as usize) % 2 != 0 || (output as usize) % 2 != 0
        || ![1, 2, 4, 8].contains(&threads) || ![0x4949, 0x4d4d].contains(&order) {
        report.error_code = 1;
        report.elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        return -1;
    }
    // SAFETY: the pinned C++ hook proves the input range belongs to its immutable mapping,
    // curve to its live LibRaw object, output to its actual nonoverlapping raw allocation.
    // The owner stays live through this call and all scoped joins. These slices never escape.
    let result = catch_unwind(AssertUnwindSafe(|| unsafe {
        decode(std::slice::from_raw_parts(input, input_length),
            std::slice::from_raw_parts_mut(output, output_length), width, height, order,
            std::slice::from_raw_parts(curve, curve_length), threads as usize, report)
    }));
    report.elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    if matches!(result, Ok(Ok(()))) { 0 } else { report.error_code = 2; -1 }
}

