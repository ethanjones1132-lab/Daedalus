import { Page } from '../../design';
import ProjectStewardView from './ProjectStewardView';
import { useWorkflow } from './WorkflowContext';
export default function ProjectStewardPage() {
  const flow = useWorkflow();
  return <Page wide><ProjectStewardView onOpenInChat={flow.openInChat} reviewSelection={flow.review} navigationSelector={flow.selector?.workflow === 'project-steward' ? flow.selector : null} onNavigationSelectorConsumed={flow.consumeSelector} onNavigateWorkflow={flow.navigateWorkflow} /></Page>;
}
