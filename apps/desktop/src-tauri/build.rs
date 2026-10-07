fn main() {
    println!(
        "cargo:rustc-env=STREAMHUB_TARGET={}",
        std::env::var("TARGET").expect("Cargo must provide TARGET")
    );
    tauri_build::build();
}
