use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn run(command: &mut Command) {
    let status = command
        .status()
        .expect("Cannot launch the native codec compiler.");
    assert!(
        status.success(),
        "Native codec compilation failed: {command:?}"
    );
}

fn configured_path(name: &str) -> PathBuf {
    println!("cargo:rerun-if-env-changed={name}");
    let path = PathBuf::from(env::var_os(name).unwrap_or_else(|| {
        panic!("{name} is required; use node scripts/ultrahdr/build-linux.mjs")
    }));
    assert!(
        path.is_absolute() && path.is_dir(),
        "Invalid {name} directory."
    );
    path
}

fn main() {
    assert_eq!(env::var("CARGO_CFG_TARGET_OS").unwrap(), "linux");
    assert_eq!(env::var("CARGO_CFG_TARGET_ARCH").unwrap(), "x86_64");
    let source = configured_path("LUMA_CODEC_SOURCE");
    let codec_build = configured_path("LUMA_CODEC_LIBRARY");
    let jpeg_build = configured_path("LUMA_CODEC_JPEG_LIBRARY");
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let bridge = root.join("../../scripts/ultrahdr/bridge.cpp");
    let probe = root.join("probe.cpp");
    let compiler = env::var_os("CXX").unwrap_or_else(|| "c++".into());
    let archiver = env::var_os("AR").unwrap_or_else(|| "ar".into());
    let mut objects = Vec::new();
    for (index, file) in [bridge, probe].iter().enumerate() {
        println!("cargo:rerun-if-changed={}", file.display());
        let object = output.join(format!("codec-{index}.o"));
        run(Command::new(&compiler)
            .args([
                "-std=c++17",
                "-O3",
                "-fPIC",
                "-ffp-contract=off",
                "-fno-fast-math",
                "-pthread",
                "-include",
                "cstdint",
                "-c",
            ])
            .arg(file)
            .arg("-I")
            .arg(&source)
            .arg("-I")
            .arg(&jpeg_build)
            .arg("-o")
            .arg(&object));
        objects.push(object);
    }
    run(Command::new(archiver)
        .arg("crs")
        .arg(output.join("libluma_codec_bridge.a"))
        .args(objects));
    for (directory, archive) in [
        (&output, "libluma_codec_bridge.a"),
        (&codec_build, "libuhdr.a"),
        (&jpeg_build, "libjpeg.a"),
    ] {
        let path = directory.join(archive);
        assert!(
            Path::new(&path).is_file(),
            "Missing archive: {}",
            path.display()
        );
        println!("cargo:rerun-if-changed={}", path.display());
        println!("cargo:rustc-link-search=native={}", directory.display());
    }
    println!("cargo:rerun-if-env-changed=CXX");
    println!("cargo:rerun-if-env-changed=AR");
    println!("cargo:rustc-link-lib=static=luma_codec_bridge");
    println!("cargo:rustc-link-lib=static=uhdr");
    println!("cargo:rustc-link-lib=static=jpeg");
    println!("cargo:rustc-link-lib=dylib=stdc++");
    println!("cargo:rustc-link-lib=dylib=pthread");
    println!("cargo:rustc-link-lib=dylib=m");
}
