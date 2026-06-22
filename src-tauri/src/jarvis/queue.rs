use crate::jarvis::types::JarvisConfig;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};

const QUEUE_CAPACITY: usize = 10;

#[derive(Debug)]
pub struct JarvisRequest {
    pub source: String,
    pub message: String,
    pub session_id: String,
    pub reply_tx: oneshot::Sender<Result<(), String>>,
}

#[derive(Clone)]
pub struct MessageQueue {
    pub sender: mpsc::Sender<JarvisRequest>,
}

impl MessageQueue {
    /// Create a new message queue with the given config.
    /// The consumer task is spawned immediately and processes messages one at a time.
    pub fn new(config: Arc<Mutex<JarvisConfig>>) -> Self {
        let (tx, mut rx) = mpsc::channel::<JarvisRequest>(QUEUE_CAPACITY);
        let config_clone = config.clone();

        // Single consumer task — processes one message at a time.
        // Use Tauri's global async runtime (not bare `tokio::spawn`): new() is called
        // from the synchronous run() entry point before any ambient Tokio runtime
        // exists, so `tokio::spawn` would panic with "there is no reactor running".
        tauri::async_runtime::spawn(async move {
            while let Some(req) = rx.recv().await {
                let _config_guard = config_clone.lock().await;
                drop(_config_guard);

                // For now, just acknowledge the request
                // The actual subprocess spawn happens in the Tauri command handler
                // which has access to the AppHandle for event emission
                let _ = req.reply_tx.send(Ok(()));
            }
        });

        MessageQueue { sender: tx }
    }

    pub async fn enqueue(
        &self,
        source: String,
        message: String,
        session_id: String,
    ) -> Result<(), String> {
        let (reply_tx, reply_rx) = oneshot::channel();

        let request = JarvisRequest {
            source,
            message,
            session_id,
            reply_tx,
        };

        self.sender
            .send(request)
            .await
            .map_err(|_| "Jarvis queue is closed".to_string())?;

        reply_rx
            .await
            .map_err(|_| "Queue reply channel closed".to_string())?
    }

    pub fn try_enqueue(
        &self,
        source: String,
        message: String,
        session_id: String,
    ) -> Result<(), String> {
        let (reply_tx, _reply_rx) = oneshot::channel();

        let request = JarvisRequest {
            source,
            message,
            session_id,
            reply_tx,
        };

        self.sender.try_send(request).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => "Jarvis queue is full (10 pending)".to_string(),
            mpsc::error::TrySendError::Closed(_) => "Jarvis queue is closed".to_string(),
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Regression: MessageQueue::new() spawns its consumer task from the synchronous
    // run() entry point, BEFORE Tauri's async runtime is established. It must not rely
    // on an ambient Tokio runtime — bare `tokio::spawn` panics there with "there is no
    // reactor running". A plain `#[test]` (no `#[tokio::test]`) has no ambient runtime,
    // exactly reproducing run()'s context, so this fails if the spawn regresses.
    #[test]
    fn new_does_not_require_ambient_tokio_runtime() {
        let config = Arc::new(Mutex::new(JarvisConfig::default()));
        let _queue = MessageQueue::new(config);
    }
}
