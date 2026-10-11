import { ToastProvider } from './design';
import { NavigationProvider } from './shell/navigation';
import { Shell } from './shell/Shell';

export default function App() {
  return (
    <ToastProvider>
      <NavigationProvider>
        <Shell />
      </NavigationProvider>
    </ToastProvider>
  );
}
