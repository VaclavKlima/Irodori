//! One bounded native mask owner, common to macOS and Linux.
mod mask;
mod creative;

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args_os().collect();
    if arguments.len() == 2 && arguments[1] == "--capabilities" {
        use std::io::Write;
        std::io::stdout().lock().write_all(include_bytes!(env!("IRODORI_CPU_CAPABILITIES")))?;
        return Ok(());
    }
    if arguments.get(1).is_some_and(|value| value == "--mask-v1") {
        return mask::run(&arguments[1..]);
    }
    Err("Unsupported native helper contract. Only bounded mask requests are available.".into())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
