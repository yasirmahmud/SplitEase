'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCircle2, ChevronDown, CircleDollarSign, FileText, LockKeyhole, Plus, ReceiptText, RotateCcw, Save, Sparkles, Trash2, Upload, Users, WandSparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { parseReceiptText } from '@/lib/receipt';
import { decodeSharedSplit, isSharedSplit, type SharedSplit } from '@/lib/share-state';
import { supabase } from '@/lib/supabase';

type Person = { id: string; name: string; color: string };
type ReceiptItem = { id: string; name: string; quantity: number; price: number; assignedTo: string[]; excluded?: boolean };
type Adjustments = { savings: number; tax: number; tip: number; delivery: number };

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

function money(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
}

function slugId(value: string, index: number) {
  return `${value.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 25)}-${index}`;
}

async function textFromPdf(file: File) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      pageText += `${item.str}${item.hasEOL ? '\n' : ' '}`;
    }
    pages.push(pageText);
  }
  return pages.join('\n');
}

function sharedSplitFromUrl() {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.hash.slice(1)).get('share');
  return value ? decodeSharedSplit(value) : null;
}

export default function Home() {
  const [sharedInitial] = useState(sharedSplitFromUrl);
  const [people, setPeople] = useState<Person[]>(sharedInitial?.people ?? demoPeople);
  const [items, setItems] = useState<ReceiptItem[]>(sharedInitial?.items ?? demoItems);
  const [adjustments, setAdjustments] = useState<Adjustments>(sharedInitial?.adjustments ?? demoAdjustments);
  const [receiptName, setReceiptName] = useState(sharedInitial?.receiptName ?? 'Walmart · Aug 25, 2026');
  const [personName, setPersonName] = useState('');
  const [status, setStatus] = useState(sharedInitial ? 'Shared split loaded' : 'Demo receipt ready');
  const [busy, setBusy] = useState(false);
  const [showAdjustments, setShowAdjustments] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareStatus, setShareStatus] = useState('Loading the shared version…');
  const [currentVersion, setCurrentVersion] = useState(1);
  const [acknowledgements, setAcknowledgements] = useState<Set<string>>(new Set());
  const [ackBusy, setAckBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [hasPublishedState, setHasPublishedState] = useState(false);
  const [isDirty, setIsDirty] = useState(Boolean(sharedInitial));
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadSharedState() {
      const { data, error } = await supabase
        .from('splitease_state')
        .select('version,data,updated_at')
        .eq('id', 'current')
        .single();
      if (cancelled) return;
      if (error) {
        setIsDirty(true);
        setShareStatus('Shared state is temporarily unavailable. Your changes are still local.');
        return;
      }
      setCurrentVersion(data.version);
      if (!isSharedSplit(data.data)) {
        setIsDirty(true);
        setShareStatus('No shared version yet — configure the split and save it for everyone.');
        return;
      }
      setPeople(data.data.people);
      setItems(data.data.items);
      setAdjustments(data.data.adjustments);
      setReceiptName(data.data.receiptName);
      setStatus(`Shared version ${data.version} loaded`);
      setHasPublishedState(true);
      setIsDirty(false);
      const { data: checked } = await supabase
        .from('splitease_acknowledgements')
        .select('person_id')
        .eq('state_id', 'current')
        .eq('version', data.version);
      if (!cancelled) {
        setAcknowledgements(new Set((checked || []).map((row) => row.person_id)));
        setShareStatus(`Shared version ${data.version} is shown to everyone.`);
      }
    }
    void loadSharedState();
    return () => { cancelled = true; };
  }, []);

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

  function markUnsaved() {
    setIsDirty(true);
    setShareStatus('Changes are local — save to update the version shown to everyone.');
  }

  async function handleFile(file?: File) {
    if (!file) return;
    setBusy(true);
    setStatus(file.type === 'application/pdf' ? 'Reading PDF…' : 'Scanning image…');
    try {
      let text = '';
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        text = await textFromPdf(file);
      } else {
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
      const everyone = people.map((person) => person.id);
      setItems(parsed.items.map((item) => ({ ...item, assignedTo: item.excluded ? [] : everyone })));
      setAdjustments(parsed.adjustments);
      setReceiptName(`${parsed.merchant}${parsed.date ? ` · ${parsed.date}` : ''}`);
      setStatus(`${parsed.items.length} items found — review before splitting`);
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
      setIsDirty(true);
      setShareStatus('New receipt ready — save to show it to everyone.');
    } catch (error) {
      console.error(error);
      setStatus('Could not find items. Try a clearer image or use the demo.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function toggleAssignment(itemId: string, personId: string) {
    markUnsaved();
    setItems((current) => current.map((item) => item.id !== itemId ? item : {
      ...item,
      assignedTo: item.assignedTo.includes(personId) ? item.assignedTo.filter((id) => id !== personId) : [...item.assignedTo, personId],
    }));
  }

  function addPerson() {
    const name = personName.trim();
    if (!name) return;
    markUnsaved();
    const id = `${slugId(name, people.length)}-${Date.now()}`;
    setPeople((current) => [...current, { id, name, color: colors[current.length % colors.length] }]);
    setItems((current) => current.map((item) => item.excluded ? item : { ...item, assignedTo: [...new Set([...item.assignedTo, id])] }));
    setPersonName('');
  }

  function removePerson(id: string) {
    markUnsaved();
    setPeople((current) => current.filter((person) => person.id !== id));
    setItems((current) => current.map((item) => ({ ...item, assignedTo: item.assignedTo.filter((personId) => personId !== id) })));
  }

  function resetDemo() {
    setPeople(demoPeople); setItems(demoItems); setAdjustments(demoAdjustments);
    setReceiptName('Walmart · Aug 25, 2026'); setStatus('Demo receipt ready');
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    setIsDirty(true);
    setShareStatus('Demo restored locally — save to show it to everyone.');
  }

  async function copySummary() {
    const lines = [`SplitEase — ${receiptName}`, `Total: ${money(grandTotal)}`, '', ...totals.map((person) => `${person.name}: ${money(person.total)}`)];
    await navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  }

  async function saveForEveryone() {
    if (saving) return;
    const state: SharedSplit = { version: 1, receiptName, people, items, adjustments };
    const nextVersion = currentVersion + 1;
    setSaving(true);
    const { data, error } = await supabase
      .from('splitease_state')
      .update({ version: nextVersion, data: state, updated_at: new Date().toISOString() })
      .eq('id', 'current')
      .eq('version', currentVersion)
      .select('version')
      .single();
    setSaving(false);
    if (error || !data) {
      setShareStatus('Another person may have saved first. Refresh to load the newest version, then try again.');
      return;
    }
    setCurrentVersion(data.version);
    setAcknowledgements(new Set());
    setHasPublishedState(true);
    setIsDirty(false);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    setStatus(`Shared version ${data.version} saved`);
    setShareStatus(`Version ${data.version} saved — new visitors will see this split.`);
  }

  async function toggleAcknowledgement(person: Person) {
    if (!hasPublishedState || isDirty || ackBusy) return;
    setAckBusy(person.id);
    const alreadyChecked = acknowledgements.has(person.id);
    const request = alreadyChecked
      ? supabase.from('splitease_acknowledgements').delete().eq('state_id', 'current').eq('version', currentVersion).eq('person_id', person.id)
      : supabase.from('splitease_acknowledgements').upsert({ state_id: 'current', version: currentVersion, person_id: person.id, person_name: person.name }, { onConflict: 'state_id,version,person_id' });
    const { error } = await request;
    setAckBusy(null);
    if (error) {
      setShareStatus(`Could not update ${person.name}’s acknowledgement. Please try again.`);
      return;
    }
    setAcknowledgements((current) => {
      const next = new Set(current);
      if (alreadyChecked) next.delete(person.id); else next.add(person.id);
      return next;
    });
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-[#183b43]/10 bg-[#f7f3e9]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-5 py-4 lg:px-8">
          <a className="flex items-center gap-2.5" href="#top" aria-label="SplitEase home"><span className="grid size-10 place-items-center rounded-[14px] bg-primary text-primary-foreground shadow-[0_6px_18px_rgba(23,57,65,.18)]"><ReceiptText size={21} /></span><span className="text-xl font-black tracking-[-0.04em]">SplitEase</span></a>
          <div className="flex items-center gap-2 text-xs font-bold text-[#527078]"><LockKeyhole size={14} /> Original receipt file stays on this device</div>
        </div>
      </header>

      <section id="top" className="mx-auto max-w-[1440px] px-5 pb-8 pt-8 lg:px-8">
        <div className="mb-7 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-[#dff3a8] px-3 py-1.5 text-xs font-extrabold uppercase tracking-[.12em] text-[#284925]"><Sparkles size={13} /> Receipt splitting, minus the math</div>
            <h1 className="max-w-3xl text-4xl font-black leading-[1.02] tracking-[-.055em] sm:text-5xl">Turn one Walmart receipt into everyone’s fair share.</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Upload a receipt, tap who had what, and SplitEase handles shared items, tax, savings, and tip.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input ref={fileRef} className="sr-only" type="file" accept="application/pdf,image/*" onChange={(event) => handleFile(event.target.files?.[0])} />
            <Button className="h-11 rounded-xl px-4 font-bold" onClick={() => fileRef.current?.click()} disabled={busy}><Upload /> {busy ? 'Processing…' : 'Upload receipt'}</Button>
            <Button variant="outline" className="h-11 rounded-xl border-[#183b43]/15 bg-white/70 px-4 font-bold" onClick={resetDemo}><RotateCcw /> Use demo</Button>
            <Button className="h-11 rounded-xl bg-[#dff3a8] px-4 font-extrabold text-[#183b43] hover:bg-[#cfee87]" onClick={saveForEveryone} disabled={saving || !isDirty}><Save /> {saving ? 'Saving…' : isDirty ? 'Save for everyone' : 'Saved for everyone'}</Button>
          </div>
        </div>

        {shareStatus && <output className="mb-5 flex items-center gap-2 rounded-xl border border-[#183b43]/10 bg-white/70 px-4 py-3 text-sm font-bold text-[#49666d]"><Check className="text-[#32a379]" size={17} /> {shareStatus}</output>}

        <div className="grid gap-5 xl:grid-cols-[1fr_310px]">
          <section className="overflow-hidden rounded-[24px] border border-[#183b43]/10 bg-white shadow-[0_18px_60px_rgba(27,52,58,.08)]">
            <div className="flex flex-col gap-4 border-b border-[#183b43]/10 bg-[#fffdfa] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-[#eaf0ef] text-primary"><FileText size={19} /></span><div><h2 className="font-extrabold">{receiptName}</h2><p className="text-xs font-medium text-muted-foreground" aria-live="polite">{status}</p></div></div>
              <div className="flex items-center gap-2 rounded-xl bg-[#f4f6f2] px-3 py-2 text-xs font-bold text-[#527078]"><WandSparkles size={14} /> {items.length} lines detected</div>
            </div>

            <div className="border-b border-[#183b43]/10 px-5 py-4">
              <div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-extrabold">Who’s splitting?</h3><p className="text-xs text-muted-foreground">Add everyone who shared this order.</p></div><Users className="text-[#6b858b]" size={18} /></div>
              <div className="flex flex-wrap items-center gap-2">
                {people.map((person) => <span key={person.id} className="group flex items-center gap-2 rounded-full border border-[#183b43]/10 bg-white py-1.5 pl-2 pr-2.5 text-sm font-bold shadow-sm"><span className="grid size-6 place-items-center rounded-full text-[11px] font-black text-white" style={{ background: person.color }}>{person.name.slice(0, 1).toUpperCase()}</span>{person.name}<button aria-label={`Remove ${person.name}`} className="ml-0.5 text-[#91a2a6] transition hover:text-destructive" onClick={() => removePerson(person.id)}><Trash2 size={13} /></button></span>)}
                <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); addPerson(); }}><Input value={personName} onChange={(event) => setPersonName(event.target.value)} placeholder="Add a person" aria-label="New person name" className="h-9 w-32 rounded-full border-dashed bg-[#fafbf8] px-3" /><Button type="submit" variant="ghost" size="icon" className="rounded-full" aria-label="Add person"><Plus /></Button></form>
              </div>
            </div>

            <div className="overflow-x-auto"><table className="w-full min-w-[720px] border-collapse">
              <thead><tr className="border-b border-[#183b43]/10 bg-[#f8faf6] text-left text-[11px] font-extrabold uppercase tracking-[.1em] text-[#6a7f84]"><th className="px-5 py-3">Item</th><th className="px-3 py-3 text-center">Qty</th><th className="px-3 py-3 text-right">Price</th><th className="px-5 py-3">Split between</th></tr></thead>
              <tbody>{items.map((item) => <tr key={item.id} className={cn('border-b border-[#183b43]/8 last:border-0', item.excluded && 'bg-[#fafafa] opacity-55')}>
                <td className="max-w-[390px] px-5 py-4"><div className={cn('text-sm font-bold leading-5', item.excluded && 'line-through')}>{item.name}</div>{item.excluded && <span className="mt-1 inline-block rounded-full bg-[#eceeed] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide">Not charged</span>}</td>
                <td className="px-3 py-4 text-center text-sm font-semibold text-muted-foreground">{item.quantity}</td><td className="px-3 py-4 text-right text-sm font-extrabold tabular-nums">{money(item.price * item.quantity)}</td>
                <td className="px-5 py-4"><div className="flex flex-wrap gap-1.5">{people.map((person) => { const active = item.assignedTo.includes(person.id); return <button key={person.id} disabled={item.excluded} onClick={() => toggleAssignment(item.id, person.id)} aria-pressed={active} className={cn('flex size-8 items-center justify-center rounded-full border-2 text-xs font-black transition hover:-translate-y-0.5 disabled:cursor-not-allowed', active ? 'text-white shadow-sm' : 'border-[#dce3e2] bg-white text-[#72878b]')} style={active ? { background: person.color, borderColor: person.color } : undefined}>{active ? <Check size={14} strokeWidth={3} /> : person.name.slice(0, 1).toUpperCase()}</button>; })}</div></td>
              </tr>)}</tbody>
            </table></div>

            <button className="flex w-full items-center justify-between border-t border-[#183b43]/10 bg-[#fffdfa] px-5 py-4 text-sm font-extrabold" onClick={() => setShowAdjustments((open) => !open)} aria-expanded={showAdjustments}><span className="flex items-center gap-2"><CircleDollarSign size={17} /> Tax, savings & extras</span><ChevronDown size={17} className={cn('transition', showAdjustments && 'rotate-180')} /></button>
            {showAdjustments && <div className="grid gap-3 border-t border-[#183b43]/10 bg-[#f8faf6] p-5 sm:grid-cols-4">{(['savings', 'tax', 'delivery', 'tip'] as const).map((key) => <label key={key} className="text-xs font-extrabold capitalize text-[#597177]">{key}<div className="relative mt-1"><span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span><Input className="h-10 bg-white pl-7" min="0" step="0.01" type="number" value={adjustments[key]} onChange={(event) => { markUnsaved(); setAdjustments((current) => ({ ...current, [key]: Number(event.target.value) })); }} /></div></label>)}</div>}
          </section>

          <aside className="h-fit overflow-hidden rounded-[24px] bg-primary text-primary-foreground shadow-[0_18px_60px_rgba(23,57,65,.2)] xl:sticky xl:top-5">
            <div className="p-5">
              <div className="mb-5 flex items-start justify-between"><div><p className="text-xs font-extrabold uppercase tracking-[.13em] text-[#a9c2c6]">Everyone owes</p><h2 className="mt-1 text-3xl font-black tracking-[-.04em]">{money(grandTotal)}</h2></div><span className="grid size-10 place-items-center rounded-xl bg-white/10"><ReceiptText size={19} /></span></div>
              <div className="mb-5 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-[#dff3a8] transition-all" style={{ width: `${subtotal ? Math.min(100, assignedSubtotal / subtotal * 100) : 0}%` }} /></div>
              <div className="space-y-2.5">{totals.map((person) => { const checked = acknowledgements.has(person.id); const canAcknowledge = hasPublishedState && !isDirty; return <div key={person.id} className="flex items-center justify-between rounded-xl bg-white/[.07] px-3 py-3"><div className="flex items-center gap-2.5"><span className="size-2.5 rounded-full" style={{ background: person.color }} /><span className="font-bold">{person.name}</span></div><div className="flex items-center gap-2"><span className="text-lg font-black tabular-nums">{money(person.total)}</span><button type="button" aria-label={`${person.name} ${checked ? 'has reviewed this split; remove acknowledgement' : 'acknowledges reviewing this split'}`} aria-pressed={checked} disabled={!canAcknowledge || ackBusy === person.id} onClick={() => toggleAcknowledgement(person)} className={cn('grid size-8 place-items-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-40', checked ? 'border-[#dff3a8] bg-[#dff3a8] text-[#183b43]' : 'border-white/20 bg-white/5 text-[#91acb1] hover:border-white/40 hover:text-white')} title={canAcknowledge ? (checked ? 'Reviewed — click to undo' : 'Click when you have reviewed') : 'Save this version before acknowledging'}><CheckCircle2 size={17} /></button></div></div>; })}</div>
              {hasPublishedState && !isDirty && <p className="mt-3 text-center text-[10px] font-bold uppercase tracking-[.1em] text-[#91acb1]">{acknowledgements.size} of {people.length} reviewed</p>}
              {unassignedCount > 0 && <div className="mt-4 rounded-xl border border-[#f8d585]/25 bg-[#f8d585]/10 px-3 py-2.5 text-xs font-bold text-[#fbe2a5]">{unassignedCount} charged {unassignedCount === 1 ? 'item is' : 'items are'} still unassigned.</div>}
            </div>
            <div className="border-t border-white/10 bg-black/10 p-5"><div className="mb-4 space-y-2 text-xs text-[#bfd0d3]"><div className="flex justify-between"><span>Items</span><span>{money(subtotal)}</span></div><div className="flex justify-between"><span>Savings</span><span>−{money(adjustments.savings)}</span></div><div className="flex justify-between"><span>Tax + extras</span><span>{money(adjustments.tax + adjustments.tip + adjustments.delivery)}</span></div></div><Button onClick={copySummary} className="h-11 w-full rounded-xl bg-[#dff3a8] font-extrabold text-[#183b43] hover:bg-[#cfee87]">{copied ? <><Check /> Copied!</> : 'Copy split summary'}</Button><p className="mt-3 text-center text-[10px] leading-4 text-[#91acb1]">Shared items split evenly. Tax, savings, and extras are distributed proportionally.</p></div>
          </aside>
        </div>
      </section>
      <footer className="mx-auto flex max-w-[1440px] flex-col gap-2 border-t border-[#183b43]/10 px-5 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between lg:px-8"><p>The original receipt file is never uploaded; saved split details sync through Supabase.</p><p>PDF + image receipts · Built for GitHub Pages</p></footer>
    </main>
  );
}
