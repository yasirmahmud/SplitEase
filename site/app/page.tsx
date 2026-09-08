'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  CircleDollarSign,
  Cloud,
  CloudOff,
  Copy,
  FileText,
  History,
  LoaderCircle,
  LockKeyhole,
  Plus,
  ReceiptText,
  Sparkles,
  Trash2,
  Upload,
  Users,
  WandSparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { parseReceiptText, receiptFingerprint } from '@/lib/receipt';
import { isSharedSplit, type SharedSplit } from '@/lib/share-state';
import { supabase } from '@/lib/supabase';

type Person = { id: string; name: string; color: string };
type ReceiptItem = { id: string; name: string; quantity: number; price: number; assignedTo: string[]; excluded?: boolean };
type Adjustments = { savings: number; tax: number; tip: number; delivery: number };
type SplitSession = {
  id: string;
  title: string;
  receiptName: string;
  createdAt: string;
  updatedAt: string;
  fingerprint?: string;
  people: Person[];
  items: ReceiptItem[];
  adjustments: Adjustments;
  reviewedBy: string[];
};
type SavedWorkspace = { version: 2; activeSessionId: string; sessions: SplitSession[] };
type SyncState = 'loading' | 'saving' | 'saved' | 'offline';

const colors = ['#ff7f66', '#4f86c6', '#8b6cc7', '#32a379', '#e4a93b', '#d65d8a'];
const demoPeople: Person[] = [
  { id: 'maya', name: 'Maya', color: colors[0] },
  { id: 'jonah', name: 'Jonah', color: colors[1] },
  { id: 'sam', name: 'Sam', color: colors[2] },
];
const allDemoPersonIds = demoPeople.map((person) => person.id);
const demoItems: ReceiptItem[] = [
  { id: 'axe', name: 'AXE Fine Fragrance Body Spray, 2.9 oz', quantity: 1, price: 4.98, assignedTo: [], excluded: true },
  { id: 'nivea-soft', name: 'NIVEA Soft Moisturizing Cream, 6.8 oz', quantity: 1, price: 8.92, assignedTo: allDemoPersonIds },
  { id: 'nivea-travel', name: 'NIVEA Face & Hand Cream, Travel Size', quantity: 1, price: 1.47, assignedTo: allDemoPersonIds },
  { id: 'equate', name: 'Equate Hemorrhoidal Ointment, 2 oz', quantity: 1, price: 5.42, assignedTo: allDemoPersonIds },
  { id: 'chapstick', name: 'ChapStick Moisturizer Original, SPF 15', quantity: 1, price: 1.43, assignedTo: allDemoPersonIds },
  { id: 'straps', name: 'RDX Weight Lifting Straps', quantity: 1, price: 10.99, assignedTo: allDemoPersonIds },
  { id: 'belt', name: 'RDX Auto Lock Weight Lifting Belt', quantity: 1, price: 13.99, assignedTo: allDemoPersonIds },
];
const demoAdjustments: Adjustments = { savings: 1.98, tax: 2.49, tip: 0, delivery: 0 };
const localCacheKey = 'splitease-workspace-v2';

function now() { return new Date().toISOString(); }
function newId() { return `split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function money(value: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0); }
function slugId(value: string, index: number) { return `${value.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 25)}-${index}`; }
function shortDate(value: string) { return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(value)); }

function fingerprintForSession(session: SplitSession) {
  if (session.fingerprint) return session.fingerprint;
  if (!session.items.length) return null;
  const [merchant, date] = session.receiptName.split(' · ');
  return receiptFingerprint({ merchant, date, items: session.items, adjustments: session.adjustments });
}

function makeDemoSession(): SplitSession {
  const timestamp = now();
  return { id: 'demo', title: 'Walmart · Aug 25', receiptName: 'Walmart · Aug 25, 2026', createdAt: timestamp, updatedAt: timestamp, people: demoPeople, items: demoItems, adjustments: demoAdjustments, reviewedBy: [] };
}

function isSavedWorkspace(value: unknown): value is SavedWorkspace {
  if (!value || typeof value !== 'object') return false;
  const workspace = value as Partial<SavedWorkspace>;
  return workspace.version === 2 && typeof workspace.activeSessionId === 'string' && Array.isArray(workspace.sessions)
    && workspace.sessions.length > 0
    && workspace.sessions.every((session) => session && typeof session.id === 'string' && typeof session.title === 'string'
      && typeof session.receiptName === 'string' && Array.isArray(session.people) && Array.isArray(session.items)
      && session.adjustments && Array.isArray(session.reviewedBy));
}

function migrateSharedSplit(split: SharedSplit): SavedWorkspace {
  const timestamp = now();
  const session: SplitSession = { id: 'migrated', title: split.receiptName, receiptName: split.receiptName, createdAt: timestamp, updatedAt: timestamp, people: split.people, items: split.items, adjustments: split.adjustments, reviewedBy: [] };
  return { version: 2, activeSessionId: session.id, sessions: [session] };
}

async function textFromPdf(file: File) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = '';
    for (const item of content.items) if ('str' in item) pageText += `${item.str}${item.hasEOL ? '\n' : ' '}`;
    pages.push(pageText);
  }
  return pages.join('\n');
}

export default function Home() {
  const [sessions, setSessions] = useState<SplitSession[]>([makeDemoSession()]);
  const [activeSessionId, setActiveSessionId] = useState('demo');
  const [personName, setPersonName] = useState('');
  const [status, setStatus] = useState('Demo receipt ready');
  const [busy, setBusy] = useState(false);
  const [showAdjustments, setShowAdjustments] = useState(false);
  const [copied, setCopied] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>('loading');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const currentVersionRef = useRef(1);
  const lastSavedSnapshotRef = useRef('');

  const activeSession = useMemo(() => sessions.find((session) => session.id === activeSessionId) ?? sessions[0], [sessions, activeSessionId]);
  const displayedSessions = useMemo(() => [...sessions].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()), [sessions]);
  const people = activeSession.people;
  const items = activeSession.items;
  const adjustments = activeSession.adjustments;

  const updateActive = useCallback((change: (session: SplitSession) => SplitSession) => {
    setSessions((current) => current.map((session) => session.id === activeSessionId ? { ...change(session), updatedAt: now(), reviewedBy: [] } : session));
  }, [activeSessionId]);

  const toggleReviewed = useCallback((personId: string) => {
    setSessions((current) => current.map((session) => session.id !== activeSessionId ? session : {
      ...session,
      updatedAt: now(),
      reviewedBy: session.reviewedBy.includes(personId) ? session.reviewedBy.filter((id) => id !== personId) : [...session.reviewedBy, personId],
    }));
  }, [activeSessionId]);

  useEffect(() => {
    let cancelled = false;
    async function loadWorkspace() {
      let cached: SavedWorkspace | null = null;
      try {
        const value = localStorage.getItem(localCacheKey);
        const parsed: unknown = value ? JSON.parse(value) : null;
        if (isSavedWorkspace(parsed)) cached = parsed;
      } catch { /* An invalid cache should not block Supabase. */ }

      if (cached && !cancelled) {
        setSessions(cached.sessions);
        setActiveSessionId(cached.activeSessionId);
      }

      const { data, error } = await supabase.from('splitease_state').select('version,data,updated_at').eq('id', 'current').single();
      if (cancelled) return;
      if (error) {
        setSyncState('offline');
        setStatus(cached ? 'Saved sessions restored from this device' : 'Working locally — cloud sync is unavailable');
        setHydrated(true);
        return;
      }

      currentVersionRef.current = Number(data.version) || 1;
      const workspace = isSavedWorkspace(data.data) ? data.data : isSharedSplit(data.data) ? migrateSharedSplit(data.data) : cached;
      if (workspace) {
        setSessions(workspace.sessions);
        setActiveSessionId(workspace.sessions.some((session) => session.id === workspace.activeSessionId) ? workspace.activeSessionId : workspace.sessions[0].id);
        lastSavedSnapshotRef.current = JSON.stringify(workspace);
        setStatus(`${workspace.sessions.length} saved ${workspace.sessions.length === 1 ? 'split' : 'splits'} restored`);
      }
      setLastSavedAt(data.updated_at);
      setSyncState('saved');
      setHydrated(true);
    }
    void loadWorkspace();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const workspace: SavedWorkspace = { version: 2, activeSessionId, sessions };
    const snapshot = JSON.stringify(workspace);
    localStorage.setItem(localCacheKey, snapshot);
    if (snapshot === lastSavedSnapshotRef.current) return;
    setSyncState('saving');

    const timer = window.setTimeout(async () => {
      const nextVersion = currentVersionRef.current + 1;
      const { data, error } = await supabase.from('splitease_state')
        .update({ version: nextVersion, data: workspace, updated_at: now() })
        .eq('id', 'current')
        .eq('version', currentVersionRef.current)
        .select('version,updated_at')
        .maybeSingle();

      if (error || !data) {
        setSyncState('offline');
        setStatus('Saved on this device; cloud sync will retry after your next edit');
        return;
      }
      currentVersionRef.current = Number(data.version);
      lastSavedSnapshotRef.current = snapshot;
      setLastSavedAt(data.updated_at);
      setSyncState('saved');
    }, 700);
    return () => window.clearTimeout(timer);
  }, [sessions, activeSessionId, hydrated]);

  const chargedItems = useMemo(() => items.filter((item) => !item.excluded), [items]);
  const subtotal = useMemo(() => chargedItems.reduce((sum, item) => sum + item.price * item.quantity, 0), [chargedItems]);
  const grandTotal = subtotal - adjustments.savings + adjustments.tax + adjustments.tip + adjustments.delivery;
  const assignedSubtotal = chargedItems.reduce((sum, item) => item.assignedTo.length ? sum + item.price * item.quantity : sum, 0);
  const unassignedCount = chargedItems.filter((item) => item.assignedTo.length === 0).length;
  const totals = useMemo(() => {
    const allocated = new Map<string, number>(people.map((person) => [person.id, 0]));
    chargedItems.forEach((item) => {
      if (!item.assignedTo.length) return;
      const share = item.price * item.quantity / item.assignedTo.length;
      item.assignedTo.forEach((personId) => allocated.set(personId, (allocated.get(personId) || 0) + share));
    });
    const factor = subtotal ? grandTotal / subtotal : 0;
    return people.map((person) => ({ ...person, total: (allocated.get(person.id) || 0) * factor }));
  }, [people, chargedItems, subtotal, grandTotal]);

  async function handleFile(file?: File) {
    if (!file) return;
    setBusy(true);
    setStatus(file.type === 'application/pdf' ? 'Reading PDF…' : 'Scanning image…');
    try {
      let text = '';
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) text = await textFromPdf(file);
      else {
        const { createWorker } = await import('tesseract.js');
        const worker = await createWorker('eng', undefined, { logger: (message) => {
          if (message.status === 'recognizing text') setStatus(`Scanning image · ${Math.round((message.progress || 0) * 100)}%`);
        } });
        const result = await worker.recognize(file);
        text = result.data.text;
        await worker.terminate();
      }
      const parsed = parseReceiptText(text);
      if (!parsed.items.length) throw new Error('No item lines were found');
      const fingerprint = receiptFingerprint(parsed);
      const duplicate = sessions.find((session) => fingerprintForSession(session) === fingerprint);
      if (duplicate) {
        setActiveSessionId(duplicate.id);
        setStatus(`Duplicate found — opened “${duplicate.title}” instead`);
        return;
      }

      const timestamp = now();
      const sessionPeople = people.length ? people : demoPeople;
      const everyone = sessionPeople.map((person) => person.id);
      const receiptName = `${parsed.merchant}${parsed.date ? ` · ${parsed.date}` : ''}`;
      const receiptItems = parsed.items.map((item) => ({ ...item, assignedTo: item.excluded ? [] : everyone }));
      if (activeSession.items.length === 0) {
        updateActive((session) => ({
          ...session,
          title: receiptName,
          receiptName,
          fingerprint,
          people: sessionPeople,
          items: receiptItems,
          adjustments: parsed.adjustments,
        }));
        setStatus(`${parsed.items.length} items found — split updated`);
        return;
      }

      const session: SplitSession = {
        id: newId(), title: receiptName, receiptName, createdAt: timestamp, updatedAt: timestamp, fingerprint,
        people: sessionPeople,
        items: receiptItems,
        adjustments: parsed.adjustments,
        reviewedBy: [],
      };
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
      setStatus(`${parsed.items.length} items found — new split created`);
    } catch (error) {
      console.error(error);
      setStatus('Could not find items. Try a clearer image or PDF.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function addBlankSession() {
    const timestamp = now();
    const session: SplitSession = { id: newId(), title: 'New split', receiptName: 'Upload a receipt to begin', createdAt: timestamp, updatedAt: timestamp, people: people.map((person) => ({ ...person })), items: [], adjustments: { savings: 0, tax: 0, tip: 0, delivery: 0 }, reviewedBy: [] };
    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
    setStatus('New split ready');
  }

  function deleteSession(id: string) {
    if (sessions.length === 1 || !window.confirm('Delete this split? This cannot be undone.')) return;
    const remaining = sessions.filter((session) => session.id !== id);
    setSessions(remaining);
    if (id === activeSessionId) setActiveSessionId(remaining[0].id);
  }

  function toggleAssignment(itemId: string, personId: string) {
    updateActive((session) => ({ ...session, items: session.items.map((item) => item.id !== itemId ? item : { ...item, assignedTo: item.assignedTo.includes(personId) ? item.assignedTo.filter((id) => id !== personId) : [...item.assignedTo, personId] }) }));
  }

  function addPerson() {
    const name = personName.trim();
    if (!name) return;
    const id = `${slugId(name, people.length)}-${Date.now()}`;
    updateActive((session) => ({ ...session, people: [...session.people, { id, name, color: colors[session.people.length % colors.length] }], items: session.items.map((item) => item.excluded ? item : { ...item, assignedTo: [...new Set([...item.assignedTo, id])] }) }));
    setPersonName('');
  }

  function removePerson(id: string) {
    updateActive((session) => ({ ...session, people: session.people.filter((person) => person.id !== id), items: session.items.map((item) => ({ ...item, assignedTo: item.assignedTo.filter((personId) => personId !== id) })) }));
  }

  async function copySummary() {
    const lines = [`SplitEase — ${activeSession.receiptName}`, `Total: ${money(grandTotal)}`, '', ...totals.map((person) => `${person.name}: ${money(person.total)}`)];
    await navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  const syncLabel = syncState === 'loading' ? 'Loading saved splits…' : syncState === 'saving' ? 'Saving changes…' : syncState === 'offline' ? 'Saved on this device' : `Autosaved${lastSavedAt ? ` · ${shortDate(lastSavedAt)}` : ''}`;

  return (
    <main className="min-h-screen overflow-x-clip bg-background text-foreground">
      <header className="border-b border-[#183b43]/10 bg-[#f7f3e9]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-4 py-3 sm:px-5 sm:py-4 lg:px-8">
          <a className="flex items-center gap-2.5" href="#top" aria-label="SplitEase home"><span className="grid size-10 place-items-center rounded-[14px] bg-primary text-primary-foreground shadow-[0_6px_18px_rgba(23,57,65,.18)]"><ReceiptText size={21} /></span><span className="text-xl font-black tracking-[-0.04em]">SplitEase</span></a>
          <div className="flex items-center gap-2 text-xs font-bold text-[#527078]" title="Original receipt files stay on this device"><LockKeyhole size={15} /><span className="hidden sm:inline">Original receipt files stay on this device</span></div>
        </div>
      </header>

      <section id="top" className="mx-auto max-w-[1440px] px-4 pb-24 pt-6 sm:px-5 sm:pb-10 sm:pt-8 lg:px-8">
        <div className="mb-6 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-[#dff3a8] px-3 py-1.5 text-xs font-extrabold uppercase tracking-[.12em] text-[#284925]"><Sparkles size={13} /> Receipt splitting, minus the math</div>
            <h1 className="max-w-3xl text-3xl font-black leading-[1.04] tracking-[-.05em] sm:text-5xl">Every receipt, remembered and ready to edit.</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Upload a receipt, assign the items, and come back to any split later. Changes save automatically.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <input ref={fileRef} className="sr-only" type="file" accept="application/pdf,image/*" onChange={(event) => handleFile(event.target.files?.[0])} />
            <Button className="h-12 rounded-xl px-4 font-bold sm:h-11" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Upload />} {busy ? 'Processing…' : 'Upload receipt'}</Button>
            <Button variant="outline" className="h-12 rounded-xl border-[#183b43]/15 bg-white/70 px-4 font-bold sm:h-11" onClick={addBlankSession}><Plus /> New split</Button>
          </div>
        </div>

        <section aria-label="Saved splits" className="mb-5 rounded-[20px] border border-[#183b43]/10 bg-white/65 p-3 shadow-[0_8px_30px_rgba(27,52,58,.05)] sm:p-4">
          <div className="mb-3 flex items-center justify-between gap-3 px-1">
            <div className="flex items-center gap-2"><History size={17} /><h2 className="text-sm font-extrabold">Saved splits</h2><span className="rounded-full bg-[#e8efed] px-2 py-0.5 text-xs font-bold text-[#527078]">{sessions.length}</span></div>
            <div className={cn('flex items-center gap-1.5 text-xs font-bold', syncState === 'offline' ? 'text-[#a06426]' : 'text-[#527078]')} aria-live="polite">{syncState === 'saving' || syncState === 'loading' ? <LoaderCircle className="animate-spin" size={14} /> : syncState === 'offline' ? <CloudOff size={14} /> : <Cloud size={14} />}{syncLabel}</div>
          </div>
          <div className="flex snap-x gap-2 overflow-x-auto pb-1">
            {displayedSessions.map((session) => <button key={session.id} onClick={() => { setActiveSessionId(session.id); setStatus('Saved split opened'); }} className={cn('min-w-[170px] snap-start rounded-xl border px-3 py-2.5 text-left transition sm:min-w-[210px]', session.id === activeSession.id ? 'border-primary bg-primary text-white shadow-md' : 'border-[#183b43]/10 bg-[#fffdfa] hover:border-[#183b43]/25')} aria-current={session.id === activeSession.id ? 'true' : undefined}><span className="block truncate text-sm font-extrabold">{session.title}</span><span className={cn('mt-1 block text-xs font-medium', session.id === activeSession.id ? 'text-white/65' : 'text-muted-foreground')}>{session.items.length} items · {shortDate(session.updatedAt)}</span></button>)}
          </div>
        </section>

        <div className="grid gap-5 xl:grid-cols-[1fr_310px]">
          <section className="order-2 overflow-hidden rounded-[22px] border border-[#183b43]/10 bg-white shadow-[0_18px_60px_rgba(27,52,58,.08)] xl:order-1">
            <div className="flex flex-col gap-3 border-b border-[#183b43]/10 bg-[#fffdfa] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="flex min-w-0 items-center gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#eaf0ef] text-primary"><FileText size={19} /></span><div className="min-w-0 flex-1"><Input value={activeSession.title} onChange={(event) => updateActive((session) => ({ ...session, title: event.target.value }))} aria-label="Split name" className="h-8 border-0 bg-transparent px-0 text-base font-extrabold shadow-none focus-visible:ring-0" /><p className="truncate text-xs font-medium text-muted-foreground" aria-live="polite">{status}</p></div></div>
              <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2 rounded-xl bg-[#f4f6f2] px-3 py-2 text-xs font-bold text-[#527078]"><WandSparkles size={14} /> {items.length} lines</div><Button variant="ghost" size="icon" disabled={sessions.length === 1} onClick={() => deleteSession(activeSession.id)} aria-label="Delete this split" className="text-[#83969a] hover:text-destructive"><Trash2 /></Button></div>
            </div>

            <div className="border-b border-[#183b43]/10 px-4 py-4 sm:px-5">
              <div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-extrabold">Who’s splitting?</h3><p className="text-xs text-muted-foreground">Tap a person on each item to include them.</p></div><Users className="text-[#6b858b]" size={18} /></div>
              <div className="flex flex-wrap items-center gap-2">
                {people.map((person) => <span key={person.id} className="group flex min-h-10 items-center gap-2 rounded-full border border-[#183b43]/10 bg-white py-1.5 pl-2 pr-2.5 text-sm font-bold shadow-sm"><span className="grid size-7 place-items-center rounded-full text-[11px] font-black text-white" style={{ background: person.color }}>{person.name.slice(0, 1).toUpperCase()}</span>{person.name}<button aria-label={`Remove ${person.name}`} className="ml-0.5 grid size-7 place-items-center text-[#91a2a6] transition hover:text-destructive" onClick={() => removePerson(person.id)}><Trash2 size={14} /></button></span>)}
                <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); addPerson(); }}><Input value={personName} onChange={(event) => setPersonName(event.target.value)} placeholder="Add a person" aria-label="New person name" className="h-10 w-36 rounded-full border-dashed bg-[#fafbf8] px-3" /><Button type="submit" variant="ghost" size="icon" className="size-10 rounded-full" aria-label="Add person"><Plus /></Button></form>
              </div>
            </div>

            {items.length === 0 ? <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className="group grid min-h-64 w-full place-items-center border-0 bg-white px-6 py-12 text-center transition hover:bg-[#f8faf6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#4b828b] disabled:cursor-wait" aria-label="Upload a receipt to this split"><span><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-[#eaf0ef] text-primary transition group-hover:-translate-y-0.5 group-hover:bg-[#dff3a8]">{busy ? <LoaderCircle className="animate-spin" size={23} /> : <Upload size={23} />}</span><span className="mt-4 block font-extrabold">{busy ? 'Processing receipt…' : 'Upload a receipt'}</span><span className="mt-1 block text-sm text-muted-foreground">Choose a PDF or image to add its items.</span></span></button> : <>
              <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[720px] border-collapse">
                <thead><tr className="border-b border-[#183b43]/10 bg-[#f8faf6] text-left text-[11px] font-extrabold uppercase tracking-[.1em] text-[#6a7f84]"><th className="px-5 py-3">Item</th><th className="px-3 py-3 text-center">Qty</th><th className="px-3 py-3 text-right">Price</th><th className="px-5 py-3">Split between</th></tr></thead>
                <tbody>{items.map((item) => <tr key={item.id} className={cn('border-b border-[#183b43]/8 last:border-0', item.excluded && 'bg-[#fafafa] opacity-55')}><td className="max-w-[390px] px-5 py-4"><div className={cn('text-sm font-bold leading-5', item.excluded && 'line-through')}>{item.name}</div>{item.excluded && <span className="mt-1 inline-block rounded-full bg-[#eceeed] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide">Not charged</span>}</td><td className="px-3 py-4 text-center text-sm font-semibold text-muted-foreground">{item.quantity}</td><td className="px-3 py-4 text-right text-sm font-extrabold tabular-nums">{money(item.price * item.quantity)}</td><td className="px-5 py-4"><PersonButtons item={item} people={people} onToggle={toggleAssignment} /></td></tr>)}</tbody>
              </table></div>
              <div className="divide-y divide-[#183b43]/10 md:hidden">{items.map((item) => <article key={item.id} className={cn('p-4', item.excluded && 'bg-[#fafafa] opacity-55')}><div className="flex items-start justify-between gap-3"><div><h3 className={cn('text-sm font-bold leading-5', item.excluded && 'line-through')}>{item.name}</h3><p className="mt-1 text-xs font-semibold text-muted-foreground">Qty {item.quantity}</p></div><span className="shrink-0 text-sm font-black tabular-nums">{money(item.price * item.quantity)}</span></div>{item.excluded ? <span className="mt-3 inline-block rounded-full bg-[#eceeed] px-2 py-1 text-[10px] font-extrabold uppercase tracking-wide">Not charged</span> : <div className="mt-3"><p className="mb-2 text-[11px] font-extrabold uppercase tracking-[.08em] text-[#6a7f84]">Split between</p><PersonButtons item={item} people={people} onToggle={toggleAssignment} mobile /></div>}</article>)}</div>
            </>}

            <button className="flex min-h-14 w-full items-center justify-between border-t border-[#183b43]/10 bg-[#fffdfa] px-4 py-4 text-sm font-extrabold sm:px-5" onClick={() => setShowAdjustments((open) => !open)} aria-expanded={showAdjustments}><span className="flex items-center gap-2"><CircleDollarSign size={17} /> Tax, savings & extras</span><ChevronDown size={17} className={cn('transition', showAdjustments && 'rotate-180')} /></button>
            {showAdjustments && <div className="grid grid-cols-2 gap-3 border-t border-[#183b43]/10 bg-[#f8faf6] p-4 sm:grid-cols-4 sm:p-5">{(['savings', 'tax', 'delivery', 'tip'] as const).map((key) => <label key={key} className="text-xs font-extrabold capitalize text-[#597177]">{key}<div className="relative mt-1"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span><Input className="h-11 bg-white pl-7" min="0" step="0.01" inputMode="decimal" type="number" value={adjustments[key]} onChange={(event) => updateActive((session) => ({ ...session, adjustments: { ...session.adjustments, [key]: Number(event.target.value) } }))} /></div></label>)}</div>}
          </section>

          <aside className="order-1 h-fit overflow-hidden rounded-[22px] bg-primary text-primary-foreground shadow-[0_18px_60px_rgba(23,57,65,.2)] xl:sticky xl:top-5 xl:order-2">
            <div className="p-4 sm:p-5"><div className="mb-4 flex items-start justify-between"><div><p className="text-xs font-extrabold uppercase tracking-[.13em] text-[#a9c2c6]">Everyone owes</p><h2 className="mt-1 text-3xl font-black tracking-[-.04em]">{money(grandTotal)}</h2></div><span className="grid size-10 place-items-center rounded-xl bg-white/10"><ReceiptText size={19} /></span></div><div className="mb-4 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-[#dff3a8] transition-all" style={{ width: `${subtotal ? Math.min(100, assignedSubtotal / subtotal * 100) : 0}%` }} /></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">{totals.map((person) => { const reviewed = activeSession.reviewedBy.includes(person.id); return <button key={person.id} type="button" aria-label={`${reviewed ? 'Mark' : 'Mark'} ${person.name} as ${reviewed ? 'not reviewed' : 'reviewed'}`} onClick={() => toggleReviewed(person.id)} className="flex min-h-12 items-center justify-between rounded-xl bg-white/[.07] px-3 py-2.5 text-left"><span className="flex items-center gap-2.5"><span className="size-2.5 rounded-full" style={{ background: person.color }} /><span className="font-bold">{person.name}</span></span><span className="flex items-center gap-2"><span className="text-lg font-black tabular-nums">{money(person.total)}</span><span className={cn('grid size-7 place-items-center rounded-full border', reviewed ? 'border-[#dff3a8] bg-[#dff3a8] text-[#183b43]' : 'border-white/20 text-[#91acb1]')}><Check size={15} /></span></span></button>; })}</div>{unassignedCount > 0 && <div className="mt-4 rounded-xl border border-[#f8d585]/25 bg-[#f8d585]/10 px-3 py-2.5 text-xs font-bold text-[#fbe2a5]">{unassignedCount} charged {unassignedCount === 1 ? 'item is' : 'items are'} still unassigned.</div>}</div>
            <div className="border-t border-white/10 bg-black/10 p-4 sm:p-5"><div className="mb-4 space-y-2 text-xs text-[#bfd0d3]"><div className="flex justify-between"><span>Items</span><span>{money(subtotal)}</span></div><div className="flex justify-between"><span>Savings</span><span>−{money(adjustments.savings)}</span></div><div className="flex justify-between"><span>Tax + extras</span><span>{money(adjustments.tax + adjustments.tip + adjustments.delivery)}</span></div></div><Button onClick={copySummary} className="h-12 w-full rounded-xl bg-[#dff3a8] font-extrabold text-[#183b43] hover:bg-[#cfee87]">{copied ? <><Check /> Copied!</> : <><Copy /> Copy split summary</>}</Button></div>
          </aside>
        </div>
      </section>
      <footer className="mx-auto flex max-w-[1440px] flex-col gap-2 border-t border-[#183b43]/10 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-5 lg:px-8"><p>Receipt files stay on your device; parsed split details autosave through Supabase.</p><p>PDF + image receipts · Duplicate-aware</p></footer>
    </main>
  );
}

function PersonButtons({ item, people, onToggle, mobile = false }: { item: ReceiptItem; people: Person[]; onToggle: (itemId: string, personId: string) => void; mobile?: boolean }) {
  return <div className="flex flex-wrap gap-2">{people.map((person) => { const active = item.assignedTo.includes(person.id); return <button key={person.id} disabled={item.excluded} onClick={() => onToggle(item.id, person.id)} aria-pressed={active} aria-label={`${active ? 'Remove' : 'Assign'} ${person.name}`} className={cn('flex items-center justify-center rounded-full border-2 text-xs font-black transition active:scale-95 disabled:cursor-not-allowed', mobile ? 'min-h-11 gap-1.5 px-3' : 'size-9', active ? 'text-white shadow-sm' : 'border-[#dce3e2] bg-white text-[#72878b]')} style={active ? { background: person.color, borderColor: person.color } : undefined}>{active && <Check size={14} strokeWidth={3} />}{mobile && person.name}{!mobile && !active && person.name.slice(0, 1).toUpperCase()}</button>; })}</div>;
}
