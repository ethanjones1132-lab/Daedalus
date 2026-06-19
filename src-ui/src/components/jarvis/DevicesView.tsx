import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  PageTransition,
  AnimatedList,
  GlassCard,
  StatusDot,
  Pill,
  SectionHeader,
  LoadingState,
  ErrorState,
  EmptyState,
  useToast,
} from '../ui';

interface Device {
  id: string;
  name: string;
  device_type: string;
  status: string;
  last_seen: string;
  address?: string;
  paired: boolean;
}

export default function DevicesView() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchDevices = useCallback(async () => {
    try {
      const r = await invoke<Device[]>('get_devices');
      setDevices(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDevices(); }, [fetchDevices]);

  const { success, error: toastError } = useToast();

  const handleAdd = async () => {
    if (!newName.trim() || !newType.trim()) return;
    setAdding(true);
    const addedName = newName.trim();
 
      await invoke('add_device', { name: addedName, deviceType: newType.trim() });
      success(`Device "${addedName}" added successfully.`, 'Device Added');
      setNewName('');
      setNewType('');
      await fetchDevices();
    } catch (e) {
      toastError(`Failed to add device: ${e}`, 'Device Error');
      console.error('Failed to add device:', e);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await invoke('remove_device', { id });
      success('Device removed successfully.', 'Device Removed');
      await fetchDevices();
    } catch (e) {
      toastError(`Failed to remove device: ${e}`, 'Device Error');
      console.error('Failed to remove device:', e);
    }
  };

  if (loading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;

  return (
    <PageTransition>
      <SectionHeader title="Devices" count={devices.length} />

      <GlassCard className="mb-6">
        <h3 className="text-sm font-semibold text-bone mb-3">Add Device</h3>
        <div className="flex gap-3 items-end">
          <div className="flex-1">