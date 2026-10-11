import { useId, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  AlertLine,
  Badge,
  EmptyState,
  IconButton,
  Page,
  PageHeader,
  SearchInput,
  Select,
  Skeleton,
  StatusLine,
  Tabs,
} from '../../design';
import { skillCandidateMutationLocked } from '../../domain/skill-candidate-operation-state';
import { CandidatesTab } from './CandidatesTab';
import { ObservationStrip } from './ObservationStrip';
import { SkillCard } from './SkillCard';
import { SkillDetail } from './SkillDetail';
import { useSkillsController } from './useSkillsController';
import {
  candidateIdOf,
  isDistilledCandidate,
  skillMeta,
  type Skill,
  type SkillFilter,
} from './skill-model';

type SectionTab = 'installed' | 'candidates';

export function SkillsPage() {
  const ctl = useSkillsController();
  const { skills, candidates, candidateCurrent, candidateMutations } = ctl;
  const [section, setSection] = useState<SectionTab>('installed');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SkillFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailId = useId();
  const tabsId = useId();
  const inspectionButtons = useRef(new Map<string, HTMLButtonElement>());
  const searchInput = useRef<HTMLInputElement>(null);

  const closeInspection = () => {
    const opener = selectedId ? inspectionButtons.current.get(selectedId) : null;
    setSelectedId(null);
    // Filtering or a refreshed list may have removed the selected row.
    if (opener?.isConnected) opener.focus();
    else searchInput.current?.focus();
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (filter === 'enabled' && !s.enabled) return false;
      if (filter === 'disabled' && s.enabled) return false;
      if (filter === 'candidates' && !isDistilledCandidate(s)) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (skillMeta(s).category?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [skills, query, filter]);

  const selected = useMemo(() => skills.find((s) => s.id === selectedId) ?? null, [skills, selectedId]);
  const selectedCandidateId = selected ? candidateIdOf(selected) : null;
  const selectedCandidate = selectedCandidateId ? (candidates?.[selectedCandidateId] ?? null) : null;
  const selectedCandidateMutation = selectedCandidateId ? (candidateMutations[selectedCandidateId] ?? null) : null;
  const enabledCount = skills.filter((s) => s.enabled).length;

  const skillByCandidate = useMemo(() => {
    const map: Record<string, Skill> = {};
    for (const s of skills) {
      const cid = candidateIdOf(s);
      if (cid) map[cid] = s;
    }
    return map;
  }, [skills]);

  const candidateCount = candidates ? Object.keys(candidates).length : undefined;

  return (
    <Page wide>
      <PageHeader
        eyebrow="Build"
        title="Skills"
        description="Browse, toggle, inspect, and restore skill revisions — and review the skills Jarvis distils from its own work."
        actions={
          <>
            <Badge tone={enabledCount > 0 ? 'ok' : 'neutral'}>{enabledCount} enabled</Badge>
            <IconButton aria-label="Refresh skills" variant="secondary" onClick={() => void ctl.fetchSkills()}>
              <RefreshCw aria-hidden="true" />
            </IconButton>
          </>
        }
      >
        <Tabs<SectionTab>
          aria-label="Skills sections"
          idBase={tabsId}
          value={section}
          onChange={setSection}
          items={[
            { id: 'installed', label: 'Installed', meta: skills.length > 0 ? skills.length : undefined },
            { id: 'candidates', label: 'Candidates', meta: candidateCount },
          ]}
        />
      </PageHeader>

      <div role="tabpanel" id={`${tabsId}-panel-${section}`} aria-labelledby={`${tabsId}-tab-${section}`}>
        {section === 'installed' ? (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <SearchInput
                ref={searchInput}
                value={query}
                onChange={setQuery}
                placeholder="Search skills…"
                aria-label="Search skills"
                clearLabel="Clear search"
                className="min-w-[220px] flex-1 sm:max-w-sm"
              />
              <Select
                aria-label="Filter skills"
                value={filter}
                onChange={(e) => setFilter(e.target.value as SkillFilter)}
                className="w-44"
              >
                <option value="all">All</option>
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
                <option value="candidates">Distilled candidates</option>
              </Select>
              {!ctl.loading && !ctl.error && skills.length > 0 && (
                <span className="ml-auto font-mono text-[11px] text-ink-3 tabular">
                  {filtered.length} of {skills.length}
                </span>
              )}
            </div>

            <div className={selected ? 'grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_480px]' : undefined}>
              <div className="min-w-0">
                {ctl.loading ? (
                  <div className="flex flex-col gap-4">
                    <StatusLine>Loading skills…</StatusLine>
                    <div aria-hidden="true" className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(290px,1fr))]">
                      {Array.from({ length: 6 }, (_, i) => (
                        <Skeleton key={i} className="h-36 rounded-[10px]" />
                      ))}
                    </div>
                  </div>
                ) : ctl.error ? (
                  <AlertLine onRetry={() => void ctl.fetchSkills()}>{ctl.error}</AlertLine>
                ) : filtered.length === 0 ? (
                  <EmptyState title="No skills match the current filter." />
                ) : (
                  <ul className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(290px,1fr))]">
                    {filtered.map((s) => {
                      const cid = candidateIdOf(s);
                      const candidate = cid ? (candidates?.[cid] ?? null) : null;
                      const mutation = cid ? (candidateMutations[cid] ?? null) : null;
                      return (
                        <SkillCard
                          key={s.id}
                          skill={s}
                          selected={selectedId === s.id}
                          detailRegionId={`${detailId}-${s.id}`}
                          inspectRef={(node) => {
                            if (node) inspectionButtons.current.set(s.id, node);
                            else inspectionButtons.current.delete(s.id);
                          }}
                          onSelect={() => setSelectedId(s.id)}
                          candidate={candidate}
                          candidateCurrent={candidateCurrent}
                          candidateMutation={mutation}
                          candidateLocked={skillCandidateMutationLocked(mutation)}
                          onCandidateAction={(action) => {
                            if (cid) void ctl.runCandidateAction(s.name, cid, action);
                          }}
                          onRetryCandidate={() => {
                            if (cid) void ctl.retryCandidateMutation(s.name, cid);
                          }}
                          togglePending={ctl.togglePending[s.id] === true}
                          toggleError={ctl.toggleError[s.id] === true}
                          onToggle={() => void ctl.toggle(s)}
                        />
                      );
                    })}
                  </ul>
                )}
              </div>

              {selected && (
                <div className="min-w-0 xl:sticky xl:top-0">
                  <SkillDetail
                    key={selected.id}
                    skill={selected}
                    regionId={`${detailId}-${selected.id}`}
                    candidateDetail={selectedCandidate}
                    candidateCurrent={candidateCurrent}
                    candidateMutation={selectedCandidateMutation}
                    onCandidateAction={(action) => {
                      if (selectedCandidate) void ctl.runCandidateAction(selected.name, selectedCandidate.id, action);
                    }}
                    onRetryCandidate={() => {
                      if (selectedCandidateId) void ctl.retryCandidateMutation(selected.name, selectedCandidateId);
                    }}
                    onClose={closeInspection}
                    onToggle={(skill) => void ctl.toggle(skill)}
                    togglePending={ctl.togglePending[selected.id] === true}
                    toggleError={ctl.toggleError[selected.id] === true}
                    onChanged={() => void ctl.fetchSkills()}
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <CandidatesTab
            candidates={candidates}
            loading={ctl.candidateState.loading}
            current={candidateCurrent}
            skillByCandidate={skillByCandidate}
            mutations={candidateMutations}
            onAction={(name, cid, action) => void ctl.runCandidateAction(name, cid, action)}
            onRetry={(name, cid) => void ctl.retryCandidateMutation(name, cid)}
            onOpenSkill={(skill) => {
              setSection('installed');
              setQuery('');
              setFilter('all');
              setSelectedId(skill.id);
            }}
          />
        )}
      </div>

      <ObservationStrip
        runtimeSkills={ctl.runtimeSkills}
        runtimeTools={ctl.runtimeTools}
        candidateState={ctl.candidateState}
        candidateCurrent={candidateCurrent}
        onRetrySkills={() => void ctl.refreshRuntimeSkills(true)}
        onRetryTools={() => void ctl.refreshRuntimeTools(true)}
        onRetryCandidates={() => void ctl.refreshCandidates(true)}
      />
    </Page>
  );
}

export default SkillsPage;
