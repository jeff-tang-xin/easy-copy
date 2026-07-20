fn main() {
    // Force rebuild when icons change
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}