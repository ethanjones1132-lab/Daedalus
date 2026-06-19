  const handleAnalyze = useCallback(async () => {
    if (!selectedPlayer || !line) return;

    setIsStreaming(true);
    setStreamedText('');
    setPrediction(null);
    setError(null);

    try {
      const message = `Analyze ${selectedPlayer} vs ${opponent} for ${selectedStat}. Line is ${line}. Should I pick OVER or UNDER? Provide detailed analysis with structured JSON output.`;

      await invoke('jarvis_send_message', { message, sessionId });

      await fetch(`${JARVIS_API}/chat/prizepicks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          session_id: sessionId,
          player: selectedPlayer,
          stat_type: selectedStat,
          line: parseFloat(line),
          opponent,
        }),
      }).catch(() => {});
    } catch (e) {
      setIsStreaming(false);
      setError(String(e));
    }
  }, [selectedPlayer, selectedStat, line, opponent, sessionId]);

  const handleQuickAsk = useCallback(async (question: string) => {
    setIsStreaming(true);
    setStreamedText('');
    setPrediction(null);
    setError(null);

    try {
      await invoke('jarvis_send_message', { message: question, sessionId });

      await fetch(`${JARVIS_API}/chat/prizepicks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: question,
          session_id: sessionId,
          include_full_db: true,
        }),
      }).catch(() => {});
    } catch (e) {
      setIsStreaming(false);
      setError(String(e));
    }
  }, [sessionId]);

  const handleGenerateWeeklyPicks = useCallback(async () => {
    setWeeklyLoading(true);
    setError(null);

    // Generate matchups from all players with their most likely opponents