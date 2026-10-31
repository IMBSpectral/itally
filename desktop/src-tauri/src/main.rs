// Spectral Tally desktop shell.
//
// The app is the same React front end and Node server as the web version. This shell:
//   1. starts the bundled server (resources/app/node/node.exe server/index.mjs) on a free
//      loopback port, with the company data in the user's app-data folder (PGlite);
//   2. ties the server to this process with a Windows job object, so it can never outlive
//      the app (two servers on one data folder would corrupt it);
//   3. shows a splash page, then points the window at the server once /api/health answers;
//   4. allows one running copy only: a second launch just brings the window forward.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, Url};

/// The running server, kept so it can be stopped when the app exits.
struct Server {
    child: Mutex<Option<Child>>,
    #[cfg(windows)]
    _job: Option<win32job::Job>,
}

/// Tauri hands back Windows paths in verbatim form (`\\?\D:\...`), which Node can't resolve
/// its entry script from. Drop the prefix for ordinary drive paths.
fn plain(p: PathBuf) -> PathBuf {
    match p.to_str().and_then(|s| s.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with(r"UNC\") => PathBuf::from(rest),
        _ => p,
    }
}

fn free_port() -> std::io::Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// One plain HTTP request to /api/health; true on a 200.
fn healthy(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    if s.write_all(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").is_err() {
        return false;
    }
    let mut head = [0u8; 16];
    matches!(s.read(&mut head), Ok(n) if n >= 12 && head[..12].ends_with(b"200"))
}

fn start_server(app_dir: &Path, data_dir: &Path, log_path: &Path, port: u16) -> std::io::Result<Child> {
    let log = File::create(log_path)?;
    let mut cmd = Command::new(app_dir.join("node").join("node.exe"));
    cmd.arg(app_dir.join("server").join("index.mjs"))
        .current_dir(data_dir)
        .env("DATABASE_URL", format!("pglite:{}", data_dir.join("db").display()))
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("STATIC_DIR", app_dir.join("web"))
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000; // no console window for the server
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

#[cfg(windows)]
fn kill_with_app(child: &Child) -> Option<win32job::Job> {
    use std::os::windows::io::AsRawHandle;
    let job = win32job::Job::create().ok()?;
    let mut info = job.query_extended_limit_info().ok()?;
    info.limit_kill_on_job_close();
    job.set_extended_limit_info(&info).ok()?;
    job.assign_process(child.as_raw_handle() as isize).ok()?;
    Some(job)
}

/// Replace the splash text with an error the user can act on.
fn show_error(window: &tauri::WebviewWindow, message: &str) {
    let text = message.replace('\\', "\\\\").replace('`', "\\`").replace('$', "\\$");
    let _ = window.eval(format!(
        "document.getElementById('status').textContent = 'Could not start';\
         document.getElementById('err').textContent = `{text}`;"
    ));
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            let app_dir = plain(app.path().resource_dir()?.join("app"));
            let data_dir = plain(app.path().app_data_dir()?.join("data"));
            let log_dir = plain(app.path().app_log_dir()?);
            fs::create_dir_all(&data_dir)?;
            fs::create_dir_all(&log_dir)?;
            let log_path = log_dir.join("server.log");

            let port = free_port()?;
            let child = start_server(&app_dir, &data_dir, &log_path, port)?;
            #[cfg(windows)]
            let job = kill_with_app(&child);
            app.manage(Server {
                child: Mutex::new(Some(child)),
                #[cfg(windows)]
                _job: job,
            });

            // wait for the server off the UI thread, then point the window at it
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let window = handle.get_webview_window("main").expect("main window");
                let started = Instant::now();
                loop {
                    if healthy(port) {
                        let url: Url = format!("http://127.0.0.1:{port}/").parse().expect("url");
                        let _ = window.navigate(url);
                        return;
                    }
                    let exited = handle
                        .state::<Server>()
                        .child
                        .lock()
                        .ok()
                        .and_then(|mut c| c.as_mut().and_then(|c| c.try_wait().ok().flatten()));
                    if let Some(status) = exited {
                        show_error(&window, &format!("The server stopped ({status}).\nDetails: {}", log_path.display()));
                        return;
                    }
                    if started.elapsed() > Duration::from_secs(90) {
                        show_error(&window, &format!("The server did not start in time.\nDetails: {}", log_path.display()));
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Spectral Tally");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Server>().child.lock().ok().and_then(|mut c| c.take()) {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
