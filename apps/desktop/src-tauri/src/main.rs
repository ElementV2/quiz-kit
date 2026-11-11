// Quiz desktop launcher (ADR-0014): starts the show server (Node sidecar + bundled server), restarts it if it
// stops unexpectedly (the journal makes a restart lossless, ADR-0003), shows the home page once the port answers,
// and stops the server when the window closes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Show server port: `QUIZ_PORT` if set (tests, a second show on the same PC), else 7300.
fn port() -> u16 {
    std::env::var("QUIZ_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(7300)
}

struct Server {
    child: Mutex<Option<CommandChild>>,
    quitting: AtomicBool,
    /// Consecutive quick crashes: the restart delay grows (port taken, broken data dir…) up to 10 s.
    crashes: std::sync::atomic::AtomicU32,
}

fn start_server(app: &AppHandle, server: Arc<Server>) -> Result<(), Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?;
    let data = app.path().app_data_dir()?.join("show");
    std::fs::create_dir_all(&data)?;
    let entry = resources.join("server").join("main.mjs");
    let (mut rx, child) = app
        .shell()
        .sidecar("quiz-node")?
        .args([entry.to_string_lossy().to_string()])
        .env("QUIZ_DATA_DIR", data.to_string_lossy().to_string())
        .env("QUIZ_APPS_DIR", resources.join("apps").to_string_lossy().to_string())
        .env("QUIZ_PORT", port().to_string())
        // The server stops by itself if this launcher dies without stopping it (no orphan).
        .env("QUIZ_PARENT_PID", std::process::id().to_string())
        .spawn()?;
    *server.child.lock().expect("server lock") = Some(child);
    let handle = app.clone();
    let started = std::time::Instant::now();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Terminated(_) = event {
                *server.child.lock().expect("server lock") = None;
                if !server.quitting.load(Ordering::SeqCst) {
                    // Crash or kill: restart; state comes back from the journal. Quick repeated crashes back off.
                    let crashes = if started.elapsed() < Duration::from_secs(30) { server.crashes.fetch_add(1, Ordering::SeqCst) + 1 } else { server.crashes.store(0, Ordering::SeqCst); 0 };
                    restart_with_backoff(handle.clone(), server.clone(), crashes).await;
                }
                break;
            }
        }
    });
    Ok(())
}

/// Restarts the server, retrying (with growing delays, never blocking a runtime thread) until it starts or the
/// app quits: a failed restart must never leave the show without a server and without a word.
async fn restart_with_backoff(handle: AppHandle, server: Arc<Server>, mut crashes: u32) {
    loop {
        let delay = (800u64 << crashes.min(4)).min(10_000);
        tokio::time::sleep(Duration::from_millis(delay)).await;
        if server.quitting.load(Ordering::SeqCst) {
            return;
        }
        match start_server(&handle, server.clone()) {
            Ok(()) => return,
            Err(err) => {
                eprintln!("Quizzkit : redémarrage du serveur impossible ({err}), nouvel essai");
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.set_title(&format!("Quizzkit — serveur arrêté, nouvel essai… ({err})"));
                }
                crashes += 1;
            }
        }
    }
}

/// Shows the home page as soon as the server accepts connections (first start: a few seconds).
fn open_home_when_ready(app: AppHandle) {
    std::thread::spawn(move || {
        for _ in 0..600 {
            if TcpStream::connect(("127.0.0.1", port())).is_ok() {
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(url) = format!("http://localhost:{}/", port()).parse() {
                        let _ = window.navigate(url);
                    }
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });
}

fn main() {
    let server = Arc::new(Server { child: Mutex::new(None), quitting: AtomicBool::new(false), crashes: std::sync::atomic::AtomicU32::new(0) });
    let for_setup = server.clone();
    let app = tauri::Builder::default()
        // One launcher per PC: a second one would fight for the port and the journal; it focuses the first instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            start_server(app.handle(), for_setup.clone())?;
            open_home_when_ready(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("lancement de Quizzkit");
    app.run(move |_handle, event| {
        if let RunEvent::Exit = event {
            server.quitting.store(true, Ordering::SeqCst);
            if let Some(child) = server.child.lock().expect("server lock").take() {
                let _ = child.kill();
            }
        }
    });
}
