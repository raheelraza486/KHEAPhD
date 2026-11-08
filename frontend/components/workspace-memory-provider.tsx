"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { emptyState, type DraftKind, type Workspace } from '@/lib/workspace/types';
import type { SelectedCompositionChain } from '@/lib/composition/selected-chain';

export function newWorkspace(kind: DraftKind): Workspace {
  return { id: crypto.randomUUID(), kind, title: '', revision: 0, state: emptyState(), reached: 1, files: {} };
}
function kindAt(path: string): DraftKind | null {
  return path === '/discovery' ? 'discovery' : path === '/workflows/create' ? 'workflow' : null;
}
type Frame = { path: string; workspace: Workspace | null; selected: SelectedCompositionChain | null };
type Transfer = { path: string; workspace?: Workspace; selected?: SelectedCompositionChain };
type Memory = {
  workspace: Workspace | null;
  selected: SelectedCompositionChain | null;
  update: (id: string, change: (value: Workspace) => Workspace) => void;
  isCurrent: (id: string, revision: number) => boolean;
  reset: (kind: DraftKind) => void;
  buildWorkflow: (source: Workspace) => void;
  runChain: (selected: SelectedCompositionChain) => void;
};
const MemoryContext = createContext<Memory | null>(null);

/** One active flow per tab. Route exits, reloads and BFCache restores clear it. */
export default function WorkspaceMemoryProvider({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const pending = useRef<Transfer | null>(null);
  const [frame, setFrame] = useState<Frame>({ path, workspace: null, selected: null });
  const current = useRef(frame); current.current = frame;
  if (frame.path !== path) {
    const transfer = pending.current?.path === path ? pending.current : null;
    setFrame({ path, workspace: transfer?.workspace ?? null, selected: transfer?.selected ?? null });
  }
  // Rendering can be replayed by Strict Mode. Consume transfers only after the
  // destination commits, so a replay cannot discard a copied flow/selection.
  useEffect(() => { pending.current = null; }, [path]);
  useEffect(() => {
    const kind = kindAt(path);
    if (kind) setFrame(value => value.path === path && !value.workspace ? { ...value, workspace: newWorkspace(kind) } : value);
  }, [path, frame.workspace]);
  useEffect(() => {
    const clear = () => {
      pending.current = null;
      current.current = { ...current.current, workspace: null, selected: null };
      setFrame(current.current);
    };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) clear(); };
    window.addEventListener('pagehide', clear);
    window.addEventListener('pageshow', restore);
    return () => { window.removeEventListener('pagehide', clear); window.removeEventListener('pageshow', restore); };
  }, []);
  const update = useCallback((id: string, change: (value: Workspace) => Workspace) => {
    setFrame(value => value.workspace?.id === id ? { ...value, workspace: change(value.workspace) } : value);
  }, []);
  const isCurrent = useCallback((id: string, revision: number) => current.current.workspace?.id === id && current.current.workspace.revision === revision, []);
  const reset = useCallback((kind: DraftKind) => {
    setFrame(value => kindAt(value.path) === kind ? { ...value, workspace: newWorkspace(kind) } : value);
  }, []);
  function buildWorkflow(source: Workspace) {
    const copied = newWorkspace('workflow');
    copied.state = { ...structuredClone(source.state), evaluation: null, selected_chain: null, link_cache: {} };
    copied.files = { ...source.files };
    copied.reached = 2;
    pending.current = { path: '/workflows/create', workspace: copied };
    router.push('/workflows/create?step=2');
  }
  function runChain(selected: SelectedCompositionChain) {
    pending.current = { path: '/compose/run', selected };
    router.push('/compose/run');
  }
  return <MemoryContext.Provider value={{ workspace: frame.path === path ? frame.workspace : null, selected: frame.path === path ? frame.selected : null, update, isCurrent, reset, buildWorkflow, runChain }}>{children}</MemoryContext.Provider>;
}
export function useWorkspaceMemory() {
  const value = useContext(MemoryContext);
  if (!value) throw new Error('Workspace memory provider is missing.');
  return value;
}
