use std::env;
use std::path::PathBuf;
use std::process::Command;

fn run(command: &mut Command) {
    let status = command.status().expect("Cannot launch native CPU build step.");
    assert!(status.success(), "Native CPU build step failed: {command:?}");
}

fn watch_tree(path: &std::path::Path) {
    for entry in std::fs::read_dir(path).expect("Cannot inspect pinned LLVM sources.") {
        let entry = entry.expect("Cannot inspect a pinned LLVM source entry.");
        if entry.file_type().expect("Cannot inspect a pinned LLVM source type.").is_dir() {
            watch_tree(&entry.path());
        } else {
            println!("cargo:rerun-if-changed={}", entry.path().display());
        }
    }
}

fn main() {
    assert_eq!(env::var("CARGO_CFG_TARGET_OS").unwrap(), "linux");
    assert_eq!(env::var("CARGO_CFG_TARGET_ARCH").unwrap(), "x86_64");
    let engine = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let project = engine.ancestors().nth(2).unwrap();
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let compiler = env::var_os("CXX").unwrap_or_else(|| "c++".into());
    let python = env::var_os("PYTHON").unwrap_or_else(|| "python3".into());
    // Ordinary CPU preview compiles its original bridge and original generated
    // math. Mask derivation checks these bytes but never edits them.
    run(Command::new(&python).arg(engine.join("generate_math.py")).arg(output.join("aces_math.inc")));
    run(Command::new(&python).arg(engine.join("prepare-mask.py")).arg(project).arg(&output));
    let mask_arithmetic = std::fs::read_to_string(output.join("mask-arithmetic-sha256.txt"))
        .expect("Cannot read the prepared native mask arithmetic identity.");
    let mask_arithmetic = mask_arithmetic.trim();
    assert!(mask_arithmetic.len() == 64
        && mask_arithmetic.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "The prepared native mask arithmetic identity must be lowercase SHA-256.");
    println!("cargo:rustc-env=IRODORI_MASK_ARITHMETIC_SHA256={mask_arithmetic}");
    let normal = output.join("cpu-render-bridge.o");
    let mask = output.join("cpu-mask-bridge.o");
    for (source, object, is_mask) in [(engine.join("bridge.cpp"), &normal, false), (engine.join("mask-bridge.cpp"), &mask, true)] {
        let mut command = Command::new(&compiler);
        command.args(["-std=c++17", "-O3", "-fPIC", "-ffp-contract=off", "-fno-fast-math", "-Wno-c++11-narrowing", "-c"])
            .arg(source).arg("-I").arg(&engine).arg("-I").arg(&output);
        if is_mask {
            // Match the actual E probe's baseline LLVM branches. These flags
            // belong only to the mask TU, never ordinary CPU presentation.
            command.args(["-mno-fma", "-mno-avx", "-mno-sse4.2"])
                .arg("-I").arg(engine.join("upstream/electron-llvm/llvm-libc"));
        }
        run(command.arg("-o").arg(object));
    }
    run(Command::new(env::var_os("AR").unwrap_or_else(|| "ar".into()))
        .arg("crs").arg(output.join("libirodori_cpu_render.a")).arg(normal).arg(mask));
    println!("cargo:rustc-env=IRODORI_CPU_CAPABILITIES={}", output.join("capabilities.json").display());
    for variable in ["CXX", "AR", "PYTHON"] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    for file in ["build.rs", "prepare-mask.py", "electron-atan2.h", "mask-bridge.cpp", "src/main.rs", "src/mask.rs", "src/creative.rs"] {
        println!("cargo:rerun-if-changed={}", engine.join(file).display());
    }
    watch_tree(&engine.join("upstream/electron-llvm"));
    for file in ["bridge.cpp", "bridge.h", "generate_math.py", "creative-color.h", "creative-color-params.h"] {
        println!("cargo:rerun-if-changed={}", engine.join(file).display());
    }
    for file in ["Lib.Academy.Utilities.ctl", "Lib.Academy.Tonescale.ctl", "Lib.Academy.OutputTransform.ctl", "Lib.Academy.ColorSpaces.ctl"] {
        println!("cargo:rerun-if-changed={}", project.join("third_party/aces-core/lib").join(file).display());
    }
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=irodori_cpu_render");
    println!("cargo:rustc-link-lib=dylib=stdc++");
    println!("cargo:rustc-link-lib=dylib=m");
}
