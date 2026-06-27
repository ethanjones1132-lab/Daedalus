use crate::jarvis::queue::MessageQueue;
use crate::jarvis::types::*;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Arc;

/// Start the TCP socket listener for agent bridge connections.
/// Uses a local TCP port since Unix sockets are not available on Windows.
pub fn start_bridge(port: u16, queue: Arc<MessageQueue>) -> Result<(), String> {
    let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
        .map_err(|e| format!("Failed to bind bridge on port {}: {}", port, e))?;

    println!("[Jarvis Bridge] Listening on 127.0.0.1:{}", port);

    let queue_clone = queue.clone();

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let queue = queue_clone.clone();
                    std::thread::spawn(move || {
                        handle_agent_connection(stream, queue);
                    });
                }
                Err(e) => {
                    eprintln!("[Jarvis Bridge] Connection error: {}", e);
                }
            }
        }
    });

    Ok(())
}

/// Stop the bridge (TCP listener will be dropped when the app exits)
pub fn stop_bridge() -> Result<(), String> {
    // TCP listener is automatically closed when the thread exits
    Ok(())
}

fn handle_agent_connection(mut stream: std::net::TcpStream, queue: Arc<MessageQueue>) {
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
