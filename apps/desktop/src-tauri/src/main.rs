#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{webview::NewWindowResponse, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

const STARTUP_ERROR: &str =
    "Could not start local hub. Check HUB_PORT, .env, or stop another streamhub process.";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(4);

struct OwnedHub {
    child: Child,
}

impl OwnedHub {
    fn wait_ready(&mut self, ready: mpsc::Receiver<u16>) -> Result<u16, ()> {
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        loop {
            if self.child.try_wait().map_err(|_| ())?.is_some() {
                return Err(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(());
            }
            match ready.recv_timeout(remaining.min(Duration::from_millis(100))) {
                Ok(port) => return Ok(port),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(()),
            }
        }
    }

    fn shutdown(&mut self) {
        // EOF asks only our child hub to stop; never connect to or kill another hub.
        drop(self.child.stdin.take());
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(50));
                }
                _ => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for OwnedHub {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn ready_port(line: &str) -> Option<u16> {
    let port = line.strip_prefix("streamhub.desktop.ready:")?;
    let port = port.strip_suffix('\n')?;
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse::<u16>().ok().filter(|port| *port > 0)
}

#[derive(Debug, PartialEq)]
enum Navigation {
    Dashboard,
    Browser,
    Reject,
}

fn navigation(url: &Url, dashboard: &Url) -> Navigation {
    if url.origin() == dashboard.origin() && url.username().is_empty() && url.password().is_none() {
        Navigation::Dashboard
    } else if url.scheme() == "https" && url.username().is_empty() && url.password().is_none() {
        Navigation::Browser
    } else {
        Navigation::Reject
    }
}

fn start_hub(app: &tauri::AppHandle) -> Result<(OwnedHub, u16), ()> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let (resources, node, data) = if cfg!(debug_assertions) {
        (
            manifest.join("../resources"),
            manifest.join(format!(
                "binaries/streamhub-node-{}{}",
                env!("STREAMHUB_TARGET"),
                std::env::consts::EXE_SUFFIX
            )),
            manifest.join("../../.."),
        )
    } else {
        (
            app.path().resource_dir().map_err(|_| ())?.join("resources"),
            std::env::current_exe()
                .map_err(|_| ())?
                .parent()
                .ok_or(())?
                .join(format!("streamhub-node{}", std::env::consts::EXE_SUFFIX)),
            app.path().app_data_dir().map_err(|_| ())?,
        )
    };
    std::fs::create_dir_all(&data).map_err(|_| ())?;
    let mut command = Command::new(node);
    command
        .arg(resources.join("hub.mjs"))
        .current_dir(&data)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env("NODE_ENV", "production")
        .env("STREAMHUB_DESKTOP", "1")
        .env("STREAMHUB_DATA_DIR", &data)
        .env("STREAMHUB_DASHBOARD_DIR", resources.join("dashboard"))
        .env("STREAMHUB_MODULES_DIR", resources.join("modules"))
        .env("STREAMHUB_PROTO_PATH", resources.join("stream_list.proto"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // The bundled Audio Monitor plugin, so first run can install it into OBS. Linux stays manual.
    #[cfg(target_os = "macos")]
    command.env("STREAMHUB_AUDIO_MONITOR_DIR", resources.join("audio-monitor/macos"));
    #[cfg(target_os = "windows")]
    command.env("STREAMHUB_AUDIO_MONITOR_DIR", resources.join("audio-monitor/windows"));
    let child = command.spawn().map_err(|_| ())?;
    let mut hub = OwnedHub { child };
    let stdout = hub.child.stdout.take().ok_or(())?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut stdout = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match stdout.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Some(port) = ready_port(&line) {
                        let _ = sender.send(port);
                    }
                }
            }
        }
    });
    let port = hub.wait_ready(receiver)?;
    Ok((hub, port))
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Mutex::new(None::<OwnedHub>));
            let handle = app.handle().clone();
            // Readiness must not block the native event loop.
            thread::spawn(move || {
                let result = start_hub(&handle).and_then(|(hub, port)| {
                    let dashboard =
                        Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|_| ())?;
                    *handle
                        .state::<Mutex<Option<OwnedHub>>>()
                        .lock()
                        .map_err(|_| ())? = Some(hub);
                    let navigation_handle = handle.clone();
                    let navigation_origin = dashboard.clone();
                    let new_window_handle = handle.clone();
                    let new_window_origin = dashboard.clone();
                    let window =
                        WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(dashboard))
                            .title("streamhub")
                            .inner_size(1280.0, 800.0)
                            .min_inner_size(800.0, 600.0);
                    // The dashboard draws a unified toolbar under the traffic lights and marks it
                    // as the drag region (allowed by the window-drag capability in tauri.conf.json).
                    #[cfg(target_os = "macos")]
                    let window = window
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .hidden_title(true)
                        .traffic_light_position(tauri::LogicalPosition::new(18.0, 19.0));
                    window
                        .on_navigation(move |url| match navigation(url, &navigation_origin) {
                            Navigation::Dashboard => true,
                            Navigation::Browser => {
                                let _ = navigation_handle
                                    .opener()
                                    .open_url(url.as_str(), None::<&str>);
                                false
                            }
                            Navigation::Reject => false,
                        })
                        .on_new_window(move |url, _| {
                            match navigation(&url, &new_window_origin) {
                                Navigation::Dashboard => {
                                    if let Some(window) =
                                        new_window_handle.get_webview_window("main")
                                    {
                                        let _ = window.navigate(url);
                                    }
                                }
                                Navigation::Browser => {
                                    let _ = new_window_handle
                                        .opener()
                                        .open_url(url.as_str(), None::<&str>);
                                }
                                Navigation::Reject => {}
                            }
                            NewWindowResponse::Deny
                        })
                        .build()
                        .map_err(|e| eprintln!("streamhub: could not open the window: {e}"))?;
                    Ok(())
                });
                if result.is_err() {
                    // Discard child logs: platform logs may contain credentials.
                    handle
                        .state::<Mutex<Option<OwnedHub>>>()
                        .lock()
                        .unwrap()
                        .take();
                    let exit_handle = handle.clone();
                    handle
                        .dialog()
                        .message(STARTUP_ERROR)
                        .title("streamhub could not start")
                        .kind(MessageDialogKind::Error)
                        .show(move |_| exit_handle.exit(1));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not initialize the desktop shell");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Mutex<Option<OwnedHub>>>()
                .lock()
                .unwrap()
                .take();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_accepts_only_nonzero_u16_ports() {
        assert_eq!(ready_port("streamhub.desktop.ready:4747\n"), Some(4747));
        assert_eq!(ready_port("streamhub.desktop.ready:65535\n"), Some(65535));
        for line in [
            "streamhub.desktop.ready:0\n",
            "streamhub.desktop.ready:65536\n",
            "streamhub.desktop.ready:+4747\n",
            "streamhub.desktop.ready: 4747\n",
            "streamhub.desktop.ready:4747\r\n",
            "streamhub.desktop.ready:4747",
            "streamhub.desktop.ready:4747 trailing\n",
            "prefix streamhub.desktop.ready:4747\n",
            "streamhub.desktop.ready:\n",
        ] {
            assert_eq!(ready_port(line), None, "{line:?}");
        }
    }

    #[test]
    fn navigation_keeps_dashboard_local_and_opens_only_https_externally() {
        let dashboard = Url::parse("http://127.0.0.1:4747/").unwrap();
        for (url, expected) in [
            ("http://127.0.0.1:4747/connections", Navigation::Dashboard),
            ("https://example.com/login", Navigation::Browser),
            ("http://127.0.0.1:4748/", Navigation::Reject),
            ("http://localhost:4747/", Navigation::Reject),
            ("http://example.com/", Navigation::Reject),
            ("http://user@127.0.0.1:4747/", Navigation::Reject),
            ("https://user:password@example.com/", Navigation::Reject),
            ("file:///etc/passwd", Navigation::Reject),
            ("javascript:alert(1)", Navigation::Reject),
            ("tauri://localhost/", Navigation::Reject),
        ] {
            assert_eq!(
                navigation(&Url::parse(url).unwrap(), &dashboard),
                expected,
                "{url}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_closes_stdin_and_reaps_owned_child() {
        let child = Command::new("sh")
            .args(["-c", "read line"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut hub = OwnedHub { child };
        hub.shutdown();
        assert!(hub.child.try_wait().unwrap().is_some());
        assert!(hub.child.stdin.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn readiness_fails_when_owned_child_exits() {
        let child = Command::new("sh")
            .args(["-c", "exit 1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut hub = OwnedHub { child };
        let (_sender, receiver) = mpsc::channel();
        let started = Instant::now();
        assert!(hub.wait_ready(receiver).is_err());
        assert!(started.elapsed() < STARTUP_TIMEOUT);
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_kills_and_reaps_an_unresponsive_owned_child() {
        let child = Command::new("sh")
            .args(["-c", "exec sleep 30"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut hub = OwnedHub { child };
        let started = Instant::now();
        hub.shutdown();
        assert!(hub.child.try_wait().unwrap().is_some());
        assert!(started.elapsed() < SHUTDOWN_TIMEOUT + Duration::from_secs(2));
    }
}
