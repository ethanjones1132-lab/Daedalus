import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { GoalNotificationSelector, ProjectStewardHandoff, WorkflowDestination, WorkflowNavigationSelector } from '../../domain/types';
import type { ProjectStewardReviewSelection } from './ProjectStewardView';
import { useNavigation } from '../../shell/navigation';

/** Retain selectors across routes; every destination re-reads native authority. */
export function WorkflowProvider({ children }: { children: ReactNode }) {
  const { navigate } = useNavigation();
  const [selector, setSelector] = useState<WorkflowNavigationSelector | null>(null);
  const [notification, setNotification] = useState<GoalNotificationSelector | null>(null);
  const [handoff, setHandoff] = useState<ProjectStewardHandoff | null>(null);
  const [review, setReview] = useState<ProjectStewardReviewSelection | null>(null);
  const navigateWorkflow = useCallback((destination: WorkflowDestination, next: WorkflowNavigationSelector | null) => {
    setSelector(next);
    navigate(destination === 'project-steward' ? 'project-steward' : destination === 'researcher' ? 'learning' : destination === 'recurring-operator' ? 'goals' : destination);
  }, [navigate]);
  const consumeSelector = useCallback((exact: WorkflowNavigationSelector) => setSelector(current => current === exact ? null : current), []);
  const consumeNotification = useCallback((exact: GoalNotificationSelector) => setNotification(current => current === exact ? null : current), []);
  const openGoalNotification = useCallback((exact: GoalNotificationSelector) => { setNotification(exact); navigate('goals'); }, [navigate]);
  const openInChat = useCallback((next: ProjectStewardHandoff) => {
    setReview({ session_id: next.session_id, goal_id: next.goal_id });
    setHandoff(next);
    navigate('sessions');
  }, [navigate]);
  const consumeHandoff = useCallback(() => setHandoff(null), []);
  const value = useMemo(() => ({ selector, notification, handoff, review, navigateWorkflow, consumeSelector, consumeNotification, openGoalNotification, openInChat, consumeHandoff }), [selector, notification, handoff, review, navigateWorkflow, consumeSelector, consumeNotification, openGoalNotification, openInChat, consumeHandoff]);
  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>;
}
const fallback = { selector: null, notification: null, handoff: null, review: null, navigateWorkflow: () => {}, consumeSelector: () => {}, consumeNotification: () => {}, openGoalNotification: () => {}, openInChat: () => {}, consumeHandoff: () => {} };
interface WorkflowValue {
  selector: WorkflowNavigationSelector | null;
  notification: GoalNotificationSelector | null;
  handoff: ProjectStewardHandoff | null;
  review: ProjectStewardReviewSelection | null;
  navigateWorkflow: (destination: WorkflowDestination, selector: WorkflowNavigationSelector | null) => void;
  consumeSelector: (selector: WorkflowNavigationSelector) => void;
  consumeNotification: (selector: GoalNotificationSelector) => void;
  openGoalNotification: (selector: GoalNotificationSelector) => void;
  openInChat: (handoff: ProjectStewardHandoff) => void;
  consumeHandoff: () => void;
}
const WorkflowContext = createContext<WorkflowValue | null>(null);
export function useWorkflow() { return useContext(WorkflowContext) ?? fallback; }
