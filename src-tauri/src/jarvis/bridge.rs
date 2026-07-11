use crate::jarvis::queue::MessageQueue;
use crate::jarvis::types::*;
use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// Lifecycle status for the agent bridge service.
#[derive(Debug, Clone, Serialize)]
pub struct BridgeLifecycleStatus {
    pub running: bool,
    pub port: u16,
}

struct BridgeService {
    shutdown: Arc<AtomicBool>,
    handle: std::thread::JoinHandle<()>,
    port: u16,
}

static BRIDGE_SERVICE: OnceLock<Mutex<Option<BridgeService>>> = OnceLock::new();

fn service() -> &'static Mutex<Option<BridgeService>> {
    BRIDGE_SERVICE.get_or_init(|| Mutex::new(None))
}

fn stop_service(guard: &mut Option<BridgeService>) -> Result<(), String> {
    if let Some(svc) = guard.take() {
        svc.shutdown.store(true, Ordering::Relaxed);
        svc.handle
            .join()
            .map_err(|e| format!("Bridge thread panicked: {:?}", e))?;
    }
    Ok(())
}

/// Start the TCP socket listener for agent bridge connections.
/// Uses a local TCP port since Unix sockets are not available on Windows.
pub fn start_bridge(port: u16, queue: Arc<MessageQueue>) -> Result<BridgeLifecycleStatus, String> {
    let mut guard = service().lock().map_err(|e| e.to_string())?;
    if let Some(svc) = guard.as_ref() {
        if svc.port == port {
            return Ok(BridgeLifecycleStatus {
                running: true,
                port: svc.port,
            });
        }
        stop_service(&mut guard)?;
    }

    let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
        .map_err(|e| format!("Failed to bind bridge on port {}: {}", port, e))?;
    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read bridge local port: {}", e))?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to set bridge to non-blocking: {}", e))?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_clone = shutdown.clone();
    let queue_clone = queue.clone();

    let handle = std::thread::spawn(move || loop {
        if shutdown_clone.load(Ordering::Relaxed) {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let queue = queue_clone.clone();
                std::thread::spawn(move || {
                    handle_agent_connection(stream, queue);
                });
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                eprintln!("[Jarvis Bridge] Connection error: {}", e);
                break;
            }
        }
    });

    *guard = Some(BridgeService {
        shutdown,
        handle,
        port: actual_port,
    });

    println!("[Jarvis Bridge] Listening on 127.0.0.1:{}", actual_port);
    Ok(BridgeLifecycleStatus {
        running: true,
        port: actual_port,
    })
}

/// Stop the bridge listener and join its accept thread.
pub fn stop_bridge() -> Result<(), String> {
    let mut guard = service().lock().map_err(|e| e.to_string())?;
    stop_service(&mut guard)?;
    Ok(())
}

/// Stop then restart the bridge on the requested port.
pub fn restart_bridge(
    port: u16,
    queue: Arc<MessageQueue>,
) -> Result<BridgeLifecycleStatus, String> {
    stop_bridge()?;
    start_bridge(port, queue)
}

/// Probe the currently-running bridge service, if any.
pub fn bridge_health() -> BridgeLifecycleStatus {
    let guard = match service().lock() {
        Ok(g) => g,
        Err(_) => {
            return BridgeLifecycleStatus {
                running: false,
                port: 19876,
            }
        }
    };
    let port = guard.as_ref().map(|svc| svc.port).unwrap_or(19876);
    let running = guard.as_ref().map_or(false, |svc| {
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], svc.port));
        TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
    });
    BridgeLifecycleStatus { running, port }
}

fn handle_agent_connection(mut stream: TcpStream, queue: Arc<MessageQueue>) {
    let peer = stream.peer_addr().ok();
    let agent_id = format!("{:?}", peer);

    let reader = BufReader::new(stream.try_clone().expect("Failed to clone stream"));
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };

        let request: BridgeRequest = match serde_json::from_str(line.trim()) {
            Ok(r) => r,
            Err(e) => {
                let response = BridgeResponse {
                    response: String::new(),
                    session_id: String::new(),
                    tokens_used: None,
                    error: Some(format!("Invalid request JSON: {}", e)),
                };
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&response).unwrap_or_default()
                );
                continue;
            }
        };

        let session = if request.session.is_empty() {
            "default".to_string()
        } else {
            request.session.clone()
        };

        match queue.try_enqueue(
            request.from.clone(),
            request.message.clone(),
            session.clone(),
        ) {
            Ok(()) => {
                let response = BridgeResponse {
                    response: format!("Message queued for session {}", session),
                    session_id: session,
                    tokens_used: None,
                    error: None,
                };
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&response).unwrap_or_default()
                );
            }
            Err(e) => {
                let response = BridgeResponse {
                    response: String::new(),
                    session_id: session,
                    tokens_used: None,
                    error: Some(e),
                };
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&response).unwrap_or_default()
                );
            }
        }
    }

    println!("[Jarvis Bridge] Agent disconnected: {}", agent_id);
}
