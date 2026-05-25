#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Must run before `run()` creates worker threads — `prime_user_path`
    // mutates the process environment via `set_var`, which is unsound
    // concurrently with other threads' `getenv`. See its doc comment.
    curator_lib::prime_user_path();
    curator_lib::run();
}
