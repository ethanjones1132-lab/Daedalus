  const [input, setInput] = useState(() => {
    try { return localStorage.getItem(CHAT_DRAFT_KEY) || ''; } catch { return ''; }
  });
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);
  const [unseenMessageCount, setUnseenMessageCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingTextRef = useRef<string>('');
  const flushRafRef = useRef<number | null>(null);
  const lastSeenMsgCountRef = useRef(0);

  const flushPendingText = useCallback(() => {
    flushRafRef.current = null;
    const text = pendingTextRef.current;
    if (text === '') return;
    pendingTextRef.current = '';
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant' && last.isStreaming) {
        return [...prev.slice(0, -1), { ...last, content: last.content + text, isComposing: false }];
      }
      return [...prev, { id: crypto.randomUUID(), role: 'assistant', content: text, isStreaming: true }];
    });
  }, []);

  const scheduleTextFlush = useCallback(() => {
    if (flushRafRef.current !== null) return;
    flushRafRef.current = requestAnimationFrame(flushPendingText);
  }, [flushPendingText]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const checkPin = () => {
      const threshold = 24;
      const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      setIsPinnedToBottom(pinned);
      if (pinned) setUnseenMessageCount(0);
    };
    checkPin();
    el.addEventListener('scroll', checkPin, { passive: true });
    const ro = new ResizeObserver(checkPin);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', checkPin);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const newDelta = messages.length - lastSeenMsgCountRef.current;
    if (newDelta > 0 && !isPinnedToBottom) {
      setUnseenMessageCount(c => c + newDelta);
    }
    lastSeenMsgCountRef.current = messages.length;
    if (isPinnedToBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isPinnedToBottom]);

  const handleScrollToLatest = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setUnseenMessageCount(0);
    setIsPinnedToBottom(true);
  }, []);

  useEffect(() => {
    if (!externalSessionId || externalSessionId === sessionId) return;
    setSessionId(externalSessionId);
    setMessages(loadStoredMessages(externalSessionId));
    setError(null);
  }, [externalSessionId, sessionId]);

  useEffect(() => {
    try { localStorage.setItem(CHAT_SESSION_KEY, sessionId); } catch {}
    if (isStreaming) return;
    let cancelled = false;
    invoke<StoredSessionMessage[]>('get_session_history', { sessionId })
      .then((history) => {
        if (cancelled || !Array.isArray(history)) return;
        const dbMessages = toChatMessages(history);
        if (dbMessages.length === 0) return;
        setMessages((prev) => {
          const settledCount = prev.filter((msg) => !msg.isStreaming).length;
          return dbMessages.length >= settledCount ? dbMessages : prev;
        });
      })
      .catch((e) => {
        toastError(`Failed to load session history: ${e}`);
      });
    return () => { cancelled = true; };
  }, [sessionId, isStreaming, toastError]);

  useEffect(() => {
    try { localStorage.setItem(chatMessagesKey(sessionId), JSON.stringify(messages.slice(-120))); } catch {}
  }, [messages, sessionId]);