import { memo } from 'react';

interface ToolApprovalModalProps {
  command: string;
  onApprove: () => void;
  onReject: () => void;
}

export const ToolApprovalModal = memo(function ToolApprovalModal({ command, onApprove, onReject }: ToolApprovalModalProps) {
      return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onReject}>
      <div className="bg-obsidian border border-iron/40 rounded-xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-bone font-semibold mb-2">⚠️ Tool Approval Required</h3>
        <p className="text-bone-muted text-sm mb-1">Claude wants to execute this command:</p>
        <pre className="my-3 p-3 bg-void/60 border border-iron/30 rounded-lg text-xs font-mono text-bone overflow-x-auto">{command}</pre>
        <div className="flex gap-3 justify-end mt-4">
          <button className="px-4 py-2 text-xs font-mono rounded-lg border border-error/40 text-error hover:bg-error/10 transition-colors cursor-pointer" onClick={onReject}>Reject</button>
          <button className="px-4 py-2 text-xs font-mono rounded-lg border border-cyan-neon/40 text-cyan-glow hover:bg-cyan-neon/10 transition-colors cursor-pointer" onClick={onApprove}>Approve</button>
        </div>
          </div>
    </div>
  );
});
