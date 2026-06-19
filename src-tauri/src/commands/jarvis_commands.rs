        let model_message = active_skill
            .as_ref()
            .map(model_message_for_skill)
            .unwrap_or_else(|| message.clone());
        let system_prompt_override = Some(build_system_prompt_with_skill(
            &config.system_prompt,
            active_skill.as_ref(),
        ));
        let history = prepare_session_turn(db.inner(), &sid, &message, &model)?;
        let config_json = serde_json::to_value(&config)
            .map_err(|e| format!("Failed to serialize Jarvis config: {}", e))?;

        let app_handle = app.clone();
        let sid_clone = sid.clone();
        let memory_user_message = message.clone();

        tokio::spawn(async move {
            let body = serde_json::json!({
                "message": model_message,
                "session_id": sid_clone.clone(),
                "config": config_json,
                "history": history,
                "system_prompt_override": system_prompt_override,
                "surface": "chat",
            });

            let chat_url = jarvis_url(&client, "/chat/stream").await;
            let resp = match client
                .post(chat_url)
                .timeout(chat_stream_timeout())
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .json(&body)
                .send()
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    // Bun server connection failed — fall back to direct Ollama
                    eprintln!(
                        "[Jarvis] Bun server unreachable, falling back to direct Ollama: {}",
                        e
                    );
                    let _ = app_handle.emit(
                        "jarvis://error",
                        serde_json::json!({
                            "error": format!("Bun server error (falling back to direct Ollama): {}", e),
                            "session_id": sid_clone,
                        }),
                    );
                    return;
                }
            };

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                let _ = app_handle.emit(
                    "jarvis://error",
                    serde_json::json!({
                        "error": format!("Jarvis API {}: {}", status, text),
                        "session_id": sid_clone,
                    }),
                );
                return;
            }

            // Stream handling (same as before)
            let mut stream = Box::pin(resp.bytes_stream());
            let mut buffer = String::new();
            let mut assistant_text = String::new();
            let mut had_error = false;
            let mut received_message_stop = false;

            const FLUSH_INTERVAL_MS: u128 = 30;
            const FLUSH_CHAR_THRESHOLD: usize = 64;
            const MAX_HELD_WORD_CHARS: usize = 16;
            let mut pending_text = String::new();
            let mut last_flush = std::time::Instant::now();
            let app_for_flush = app_handle.clone();
            let sid_for_flush = sid_clone.clone();
            let flush_pending =
                |pending: &mut String, last_flush: &mut std::time::Instant, force: bool| {
                    if pending.is_empty() {
                        return;
                    }
                    let now = std::time::Instant::now();
                    let elapsed_ms = now.duration_since(*last_flush).as_millis();
                    let threshold_met = elapsed_ms >= FLUSH_INTERVAL_MS
                        || pending.chars().count() >= FLUSH_CHAR_THRESHOLD;
                    if !force && !threshold_met {
                        return;
                    }
                    let to_emit = if force {
                        std::mem::take(pending)
                    } else {
                        match find_word_boundary(pending) {
                            Some(b) if b < pending.len() => {
                                let held = &pending[b..];
                                if held.chars().count() <= MAX_HELD_WORD_CHARS {
                                    let head = pending[..b].to_string();
                                    pending.replace_range(..b, "");
                                    head
                                } else {
                                    std::mem::take(pending)
                                }
                            }
                            _ => std::mem::take(pending),
                        }
                    };
                    let _ = app_for_flush.emit(
                        "jarvis://token",
                        serde_json::json!({
                            "text": to_emit,
                            "session_id": sid_for_flush.as_str(),
                        }),
                    );
                    *last_flush = now;
                };

            loop {
                let item = stream.next().await;
                match item {
                    Some(Ok(bytes)) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(line_end) = buffer.find('\n') {
                            let line = buffer[..line_end].trim().to_string();
                            buffer.drain(..line_end + 1);
                            if line.is_empty() || !line.starts_with("data: ") {
                                continue;
                            }
                            let json_str = &line["data: ".len()..];
                            if let Ok(event) = serde_json::from_str::<StreamEvent>(json_str) {
                                match event.event_type.as_str() {
                                    "init" => {}
                                    "stream_event" => {
                                        if let Some(text) = event
                                            .extra
                                            .get("delta")
                                            .and_then(|d| d.get("text"))
                                            .and_then(|t| t.as_str())
                                        {
                                            assistant_text.push_str(text);
                                            pending_text.push_str(text);
                                        }
                                    }
                                    "message_stop" => {
                                        received_message_stop = true;
                                    }
                                    "error" => {
                                        had_error = true;
                                        let err_text = event
                                            .extra
                                            .get("error")
                                            .and_then(|e| e.as_str())
                                            .unwrap_or("Unknown error");
                                        let _ = app_handle.emit(
                                            "jarvis://error",
                                            serde_json::json!({
                                                "error": err_text,
                                                "session_id": sid_clone,
                                            }),
                                        );
                                    }
                                    "result" => {
                                        if assistant_text.is_empty() {
                                            if let Some(text) = event
                                                .extra
                                                .get("result")
                                                .or_else(|| event.extra.get("content"))
                                                .and_then(|v| v.as_str())
                                            {
                                                assistant_text.push_str(text);
                                                // Emit as token so the UI displays the full text
                                                // (for non-streaming backends like Claude CLI)
                                                let _ = app_handle.emit(
                                                    "jarvis://token",
                                                    serde_json::json!({
                                                        "text": text,
                                                        "session_id": sid_clone,
                                                    }),
                                                );
                                            }
                                        }
                                    }
                                    "reasoning_step" => {
                                        let step_str = event.extra.get("step").and_then(|v| {
                                            v.as_str().map(|s| s.to_string()).or_else(|| {
                                                v.get("content")
                                                    .and_then(|c| c.as_str())
                                                    .map(|s| s.to_string())
                                            })
                                        });
                                        if let Some(step) = step_str {
                                            let _ = app_handle.emit(
                                                "jarvis://reasoning_step",
                                                serde_json::json!({
                                                    "step": step,
                                                    "session_id": sid_clone,
                                                }),
                                            );
                                        }
                                    }
                                    "reasoning_chunk" => {
                                        if let Some(text) =
                                            event.extra.get("text").and_then(|v| v.as_str())
                                        {
                                            let _ = app_handle.emit(
                                                "jarvis://reasoning_chunk",
                                                serde_json::json!({
                                                    "text": text,
                                                    "session_id": sid_clone,
                                                }),
                                            );
                                        }
                                    }
                                    "tool_call" | "tool_use" => {
                                        let id = event
                                            .extra
                                            .get("id")
                                            .and_then(|v| v.as_str())
                                            .or_else(|| {
                                                event
                                                    .extra
                                                    .get("tool_call")
                                                    .and_then(|tc| tc.get("id"))
                                                    .and_then(|v| v.as_str())
                                            })
                                            .unwrap_or("");
                                        let name = event
                                            .extra
                                            .get("name")
                                            .and_then(|v| v.as_str())
                                            .or_else(|| {
                                                event
                                                    .extra
                                                    .get("tool_name")
                                                    .and_then(|v| v.as_str())
                                            })
                                            .or_else(|| {
                                                event
                                                    .extra
                                                    .get("tool_call")
                                                    .and_then(|tc| tc.get("name"))
                                                    .and_then(|v| v.as_str())
                                            })
                                            .unwrap_or("");
                                        let input = event
                                            .extra
                                            .get("input")
                                            .cloned()
                                            .or_else(|| event.extra.get("tool_input").cloned())
                                            .or_else(|| {
                                                event
                                                    .extra
                                                    .get("tool_call")
                                                    .and_then(|tc| tc.get("arguments"))
                                                    .cloned()
                                            })
                                            .unwrap_or(serde_json::Value::Null);

                                        if !name.is_empty() {
                                            let _ = app_handle.emit(
                                                "jarvis://tool_call",
                                                serde_json::json!({
                                                    "tool_call": {
                                                        "id": id,
                                                        "name": name,
                                                        "arguments": input,
                                                    },
                                                    "session_id": sid_clone,
                                                }),
                                            );
                                        }
                                    }
                                    "tool_result" => {
                                        let call_id = event
                                            .extra
                                            .get("call_id")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let name = event
                                            .extra
                                            .get("name")
                                            .and_then(|v| v.as_str())
                                            .or_else(|| {
                                                event
                                                    .extra
                                                    .get("tool_name")
                                                    .and_then(|v| v.as_str())
                                            })
                                            .unwrap_or("");
                                        let output = event
                                            .extra
                                            .get("output")
                                            .and_then(|v| v.as_str())
                                            .or_else(|| {
                                                event
                                                    .extra
                                                    .get("tool_output")
                                                    .and_then(|v| v.as_str())
                                            })
                                            .unwrap_or("");
                                        let is_error = event
                                            .extra
                                            .get("is_error")
                                            .and_then(|v| v.as_bool())
                                            .unwrap_or(false);

                                        let _ = app_handle.emit(
                                            "jarvis://tool_result",
                                            serde_json::json!({
                                                "call_id": call_id,
                                                "name": name,
                                                "output": output,
                                                "is_error": is_error,
                                                "session_id": sid_clone,
                                            }),
                                        );
                                    }
                                    "cancelled" => {
                                        received_message_stop = true;
                                        flush_pending(
                                            &mut pending_text,
                                            &mut last_flush,
                                            true,
                                        );
                                        let _ = app_handle.emit(
                                            "jarvis://done",
                                            serde_json::json!({
                                                "session_id": sid_clone,
                                            }),
                                        );
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                        }
                        flush_pending(&mut pending_text, &mut last_flush, false);
                    }
                    Some(Err(e)) => {
                        if !stream_read_error_is_fatal(received_message_stop) {
                            eprintln!(
                                "[Jarvis] Ignoring stream read error after message_stop: {}",
                                e
                            );
                            break;
                        }
                        had_error = true;
                        let _ = app_handle.emit(
                            "jarvis://error",
                            serde_json::json!({
                                "error": format!("Stream read error: {}", e),
                                "session_id": sid_clone,
                            }),
                        );
                        break;
                    }
                    None => break,
                }
            }

            flush_pending(&mut pending_text, &mut last_flush, true);

            if !had_error && received_message_stop {
                let _ = app_handle.emit(
                    "jarvis://done",
                    serde_json::json!({ "session_id": sid_clone }),
                );
            }

            if !had_error && !assistant_text.trim().is_empty() {
                let db = app_handle.state::<AppDb>();
                if append_session_message(db.inner(), &sid_clone, "assistant", &assistant_text)
                    .is_ok()
                {
                    let conn = db.conn.lock().unwrap_or_else(|p| p.into_inner());
                    let _ = crate::jarvis::memory::engine::run_post_turn_housekeeping(
                        &conn,
                        &sid_clone,