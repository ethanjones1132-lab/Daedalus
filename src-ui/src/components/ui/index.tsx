export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="p-6 bg-red-500/10 border border-red-500/30 rounded-xl text-center"
        >
          <p className="text-red-400 text-sm font-mono mb-2">Something went wrong</p>
          <p className="text-red-400/60 text-xs font-mono">{this.state.error?.message}</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-3 px-3 py-1 text-xs font-mono text-bone-dim border border-iron/30 rounded-lg hover:border-iron/50 transition-colors"
          >
            Try Again
          </button>
        </motion.div>
      );
    }
    return this.props.children;
  }
}

// ── Skeleton Components ──
export { SkeletonCard, SkeletonText, SkeletonCircle } from './Skeleton';

// ── Toast Notifications ──
export { ToastProvider, useToast } from './Toast';
export type { Toast, ToastType } from './Toast';

// ── Mythos Primitives ──
export {
  TiltCard,
  MagneticButton,
  AnimatedNumber,
  Label,
  MetricBlock,
  ShimmerBar,
  HaloGlow,
  MythosDivider,
  MythosTooltip,
  useTiltMotion,
  useMagneticMotion,
  useEyeTrack,
  MYTHOS_SPRING,
  MYTHOS_SPRING_SOFT,
  MYTHOS_SPRING_SNAP,
} from './Mythos';
export type { TiltCardProps, MagneticButtonProps, AnimatedNumberProps, LabelProps, MetricBlockProps, ShimmerBarProps } from './Mythos';