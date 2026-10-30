//! Immutable creative-color ABI and bounded, once-per-request wire validation.
#[repr(C)]
#[derive(Default)]
pub struct Parameters {
    ranges: [[f64; 4]; 8],
    tones: [[f64; 3]; 3],
    saturation: f64,
    vibrance: f64,
    width: f64,
    balance: f64,
    pub mixer_active: u32,
    pub grading_active: u32,
}
const _: () = assert!(std::mem::size_of::<Parameters>() == 368);

unsafe extern "C" {
    fn irodori_cpu_color(values: *const f64, count: u32, output: *mut Parameters) -> i32;
}

pub fn decode(bytes: &[u8], offset: usize, saturation: f64, vibrance: f64)
    -> Result<Parameters, &'static str> {
    let packet = bytes.get(offset..offset + 52 * 8)
        .ok_or("Incomplete native creative-color packet.")?;
    let values: [f64; 52] = std::array::from_fn(|i|
        f64::from_le_bytes(packet[i * 8..i * 8 + 8].try_into().unwrap()));
    if values[0] != saturation || values[1] != vibrance {
        return Err("Native creative-color intensity does not match the frozen request.");
    }
    let mut parameters = Parameters::default();
    // SAFETY: exact aligned spans, matching repr(C) structure, and no ownership
    // transfer. C++ validates every value before publishing the complete result.
    let valid = unsafe { irodori_cpu_color(values.as_ptr(), 52, &mut parameters) };
    if valid != 1 {
        return Err("Invalid compiled native creative-color parameters.");
    }
    Ok(parameters)
}
