import { Page } from '../../design';
import LearningView from './LearningView';
import { useWorkflow } from './WorkflowContext';
export default function LearningPage() {
  const flow = useWorkflow();
  return <Page wide><LearningView navigationSelector={flow.selector?.workflow === 'researcher' ? flow.selector : null} onNavigationSelectorConsumed={flow.consumeSelector} onNavigateWorkflow={flow.navigateWorkflow} /></Page>;
}
