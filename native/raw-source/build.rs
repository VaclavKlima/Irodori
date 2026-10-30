use std::env;
use std::path::PathBuf;
use std::process::Command;

fn run(command: &mut Command) {
    let status = command
        .status()
        .expect("Cannot launch the RAW bridge compiler.");
    assert!(
        status.success(),
        "RAW bridge compilation failed: {command:?}"
    );
}

fn main() {
    assert_eq!(env::var("CARGO_CFG_TARGET_OS").unwrap(), "linux");
    assert_eq!(env::var("CARGO_CFG_TARGET_ARCH").unwrap(), "x86_64");
    println!("cargo:rerun-if-env-changed=IRODORI_RAW_SOURCE");
    println!("cargo:rerun-if-env-changed=CXX");
    println!("cargo:rerun-if-env-changed=AR");
    let source = PathBuf::from(
        env::var_os("IRODORI_RAW_SOURCE")
            .expect("IRODORI_RAW_SOURCE is required; use scripts/native-raw/build-linux.mjs"),
    );
    assert!(
        source.is_absolute() && source.is_dir(),
        "Invalid pinned LibRaw source."
    );
    let library = source.join("lib/libraw.a");
    assert!(library.is_file(), "Missing pinned libraw.a");
    let bridge = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("bridge.cpp");
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let object = output.join("raw-bridge.o");
    let compiler = env::var_os("CXX").unwrap_or_else(|| "c++".into());
    run(Command::new(compiler)
        .args([
            "-std=c++17",
            "-O3",
            "-fPIC",
            "-ffp-contract=off",
            "-fno-fast-math",
            "-DLIBRAW_NOTHREADS",
            "-c",
        ])
        .arg(&bridge)
        .arg("-I")
        .arg(&source)
        .arg("-o")
        .arg(&object));
    run(
        Command::new(env::var_os("AR").unwrap_or_else(|| "ar".into()))
            .arg("crs")
            .arg(output.join("libirodori_raw_bridge.a"))
            .arg(object),
    );
    println!("cargo:rerun-if-changed={}", bridge.display());
    println!("cargo:rerun-if-changed={}", bridge.with_file_name("rows-abi.h").display());
    println!("cargo:rerun-if-changed={}", library.display());
    println!("cargo:rustc-link-search=native={}", output.display());
    println!(
        "cargo:rustc-link-search=native={}",
        source.join("lib").display()
    );
    println!("cargo:rustc-link-lib=static=irodori_raw_bridge");
    println!("cargo:rustc-link-lib=static=raw");
    println!("cargo:rustc-link-lib=dylib=stdc++");
    println!("cargo:rustc-link-lib=dylib=m");
}
