import { Page } from '../../design';
import GoalsView from './GoalsView';
import { useWorkflow } from './WorkflowContext';
export default function GoalsPage() {
  const flow = useWorkflow();
  return <Page wide><GoalsView notificationSelector={flow.notification} onNotificationSelectorConsumed={flow.consumeNotification} navigationSelector={flow.selector?.workflow === 'recurring-operator' ? flow.selector : null} onNavigationSelectorConsumed={flow.consumeSelector} onNavigateWorkflow={flow.navigateWorkflow} /></Page>;
}
