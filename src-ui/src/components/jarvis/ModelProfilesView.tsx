  const handleCreateProfile = useCallback(async () => {
    if (!newName.trim() || !newModel.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await invoke<ModelProfile>('create_profile', {
        name: newName.trim(),
        backend: newProvider,
        model: newModel.trim(),
        temperature: parseFloat(newTemperature) || 0.7,
        maxTokens: parseInt(newMaxTokens, 10) || 4096,
        topP: parseFloat(newTopP) || 1.0,
      });
      success(`Successfully created profile "${newName}"`, 'Profile Created');
      // Reset form
      setNewName('');
      setNewModel('');
      setNewMaxTokens('4096');
      setNewTemperature('0.7');
      setNewTopP('1.0');
      setShowCreateForm(false);
      await loadData();
    } catch (e) {
      setCreateError(String(e));
      toastError(`Failed to create profile: ${e}`);
    } finally {
      setCreating(false);
    }
  }, [newName, newProvider, newModel, newTemperature, newMaxTokens, newTopP, loadData, toastError, success]);