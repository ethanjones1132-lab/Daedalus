import { ToastProvider } from './design';
import { NavigationProvider } from './shell/navigation';
import { WorkflowProvider } from './features/workflows/WorkflowContext';
import { Shell } from './shell/Shell';

export default function App() {
  return (
    <ToastProvider>
      <NavigationProvider>
        <WorkflowProvider><Shell /></WorkflowProvider>
      </NavigationProvider>
    </ToastProvider>
  );
}
