import type { RuntimeBundle } from '@raion/core';
import { parseDuration } from '@raion/schema';
import { manifestFor, type ReleaseManifest } from './releases.js';

export type ComponentAction = 'add' | 'remove' | 'recreate' | 'restart' | 'refresh' | 'unchanged';

export interface ComponentChange {
  component: string;
  action: ComponentAction;
  reasons: string[];
  /** Elevated privileges this change introduces. */
  privileges: string[];
}

export interface FileChange {
  path: string;
  change: 'add' | 'modify' | 'remove';
  component: string;
  description: string;
}

export interface DeployPlan {
  /** Release currently deployed, if any. */
  from?: string;
  /** Hash of the configuration this plan would deploy. */
  configHash: string;
  files: FileChange[];
  components: ComponentChange[];
  /** True when no file differs from the current release. */
  noChanges: boolean;
  /** Changes that add elevated privileges; applying requires explicit approval. */
  securityRelevant: string[];
  /** Host access that is disclosed but needs no approval (e.g. node_exporter's read-only host view). */
  hostAccess: string[];
  /** Changes that delete or stop collecting data; applying requires explicit approval. */
  dataAffecting: string[];
  notes: RuntimeBundle['notes'];
}

/** Compares a generated bundle with the deployed release. Pure. */
export function computePlan(
  bundle: RuntimeBundle,
  current: ReleaseManifest | undefined,
  secretsFingerprint?: string,
): DeployPlan {
  const next = manifestFor(bundle, { seq: 0, createdBy: '', workspace: '' });
  const before = new Map((current?.artifacts ?? []).map((a) => [a.path, a]));
  const after = new Map(next.artifacts.map((a) => [a.path, a]));

  const files: FileChange[] = [];
  for (const [path, a] of after) {
    const old = before.get(path);
    if (!old)
      files.push({ path, change: 'add', component: a.component, description: a.description });
    else if (old.sha256 !== a.sha256)
      files.push({ path, change: 'modify', component: a.component, description: a.description });
  }
  for (const [path, a] of before) {
    if (!after.has(path))
      files.push({ path, change: 'remove', component: a.component, description: a.description });
  }

  const oldComponents = new Map((current?.components ?? []).map((c) => [c.id, c]));
  const components: ComponentChange[] = [];
  const securityRelevant: string[] = [];
  const hostAccess: string[] = [];
  const dataAffecting: string[] = [];

  for (const c of next.components) {
    const old = oldComponents.get(c.id);
    const changedFiles = files.filter((f) => f.component === c.id).map((f) => f.path);
    let change: ComponentChange;
    if (!old) {
      change = {
        component: c.id,
        action: 'add',
        reasons: ['new component'],
        privileges: c.privileges,
      };
    } else if (old.serviceHash !== c.serviceHash) {
      change = {
        component: c.id,
        action: 'recreate',
        reasons: ['container settings or image changed'],
        privileges: [],
      };
    } else if (
      changedFiles.length > 0 &&
      changedFiles.every((p) => after.get(p)?.live ?? before.get(p)?.live)
    ) {
      change = {
        component: c.id,
        action: 'refresh',
        reasons: [`${changedFiles.length} file(s) picked up without a restart`],
        privileges: [],
      };
    } else if (changedFiles.length > 0) {
      change = {
        component: c.id,
        action: 'restart',
        reasons:
          changedFiles.length > 3
            ? [`${changedFiles.length} configuration files changed`]
            : changedFiles.map((p) => `${p} changed`),
        privileges: [],
      };
    } else if (
      c.id === 'alertmanager' &&
      secretsFingerprint !== undefined &&
      (current?.secretsFingerprint ?? '') !== secretsFingerprint
    ) {
      change = {
        component: c.id,
        action: 'restart',
        reasons: ['notification credentials changed'],
        privileges: [],
      };
    } else {
      change = { component: c.id, action: 'unchanged', reasons: [], privileges: [] };
    }
    const newPrivileges = c.privileges.filter((p) => !old?.privileges.includes(p));
    if (newPrivileges.length > 0) {
      change.privileges = newPrivileges;
      (c.requiresApproval ? securityRelevant : hostAccess).push(
        `${c.id}: ${newPrivileges.join('; ')}`,
      );
    }
    components.push(change);
  }
  for (const old of oldComponents.values()) {
    if (!next.components.some((c) => c.id === old.id)) {
      components.push({
        component: old.id,
        action: 'remove',
        reasons: ['no longer needed by the workspace'],
        privileges: [],
      });
      dataAffecting.push(
        `${old.id} will be stopped; its stored data is kept but no longer updated`,
      );
    }
  }

  if (current) {
    for (const signal of ['metrics', 'logs', 'traces'] as const) {
      const was = parseDuration(current.retention[signal]) ?? 0;
      const now = parseDuration(bundle.retention[signal]) ?? 0;
      if (now < was) {
        dataAffecting.push(
          `${signal} retention shrinks from ${current.retention[signal]} to ${bundle.retention[signal]}: older ${signal} will be deleted`,
        );
      }
    }
  }

  return {
    ...(current ? { from: current.id } : {}),
    configHash: next.configHash,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    components,
    noChanges:
      files.length === 0 &&
      !components.some((c) => c.reasons.includes('notification credentials changed')),
    securityRelevant,
    hostAccess,
    dataAffecting,
    notes: bundle.notes,
  };
}

const ACTION_TEXT: Record<ComponentAction, string> = {
  add: '+ start',
  remove: '- stop',
  recreate: '~ recreate',
  refresh: '~ refresh',
  restart: '~ restart',
  unchanged: '  unchanged',
};

/** Human-readable plan, as printed by `raion plan`. */
export function formatPlan(plan: DeployPlan): string {
  const lines: string[] = [];
  lines.push(plan.from ? `Deployed release: ${plan.from}` : 'Nothing is deployed yet.');
  if (plan.noChanges) {
    lines.push(
      'No configuration changes. Applying will only make sure every component is running.',
    );
  }
  const changed = plan.components.filter((c) => c.action !== 'unchanged');
  if (changed.length > 0) {
    lines.push('', 'Components:');
    for (const c of plan.components) {
      if (c.action === 'unchanged') continue;
      lines.push(
        `  ${ACTION_TEXT[c.action].padEnd(11)} ${c.component}${c.reasons.length ? `  (${c.reasons.join(', ')})` : ''}`,
      );
    }
  }
  if (plan.files.length > 0) {
    lines.push('', 'Generated files:');
    for (const f of plan.files) {
      const mark = f.change === 'add' ? '+' : f.change === 'remove' ? '-' : '~';
      lines.push(`  ${mark} ${f.path}`);
    }
  }
  if (plan.securityRelevant.length > 0) {
    lines.push('', 'Security-relevant changes (require --allow-privileged):');
    for (const s of plan.securityRelevant) lines.push(`  ! ${s}`);
  }
  if (plan.hostAccess.length > 0) {
    lines.push('', 'Host access (read-only, needed for host metrics):');
    for (const s of plan.hostAccess) lines.push(`  i ${s}`);
  }
  if (plan.dataAffecting.length > 0) {
    lines.push('', 'Data-affecting changes (require --allow-data-changes):');
    for (const s of plan.dataAffecting) lines.push(`  ! ${s}`);
  }
  if (plan.notes.length > 0) {
    lines.push('', 'Notes:');
    for (const n of plan.notes)
      lines.push(`  ${n.severity === 'warning' ? '!' : 'i'} ${n.message}`);
  }
  const count = (a: ComponentAction) => plan.components.filter((c) => c.action === a).length;
  lines.push(
    '',
    `Plan: ${count('add')} to start, ${count('recreate') + count('restart')} to update, ${count('remove')} to stop, ${plan.files.length} file change(s).`,
  );
  return lines.join('\n');
}
