import { useMemo, useState } from "react";
import { CheckSquare, Layers, Loader2, Pencil, Search, Square, Star, Trash2, X } from "lucide-react";
import { Chip, Input, Select } from "@/components/ui";
import { CATEGORIES, MASTERY, type LangEntry, type Mastery } from "./contract";
import { langName } from "./languages";
import { EMPTY_FILTER, filterEntries, foreignSide, libraryLanguages, type LibraryFilter } from "./library";
import { PlayButton, toastError } from "./parts";
import { newKey, useHub } from "./store";

export function LibraryView({ compact = false }: { compact?: boolean }) {
  const { library, libraryLoaded, libraryError, loadAll, deleteEntries, setDeck, setPrefs } = useHub();
  const [f, setF] = useState<LibraryFilter>(EMPTY_FILTER);
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => filterEntries(library, f), [library, f]);
  const langs = useMemo(() => libraryLanguages(library), [library]);
  const up = (p: Partial<LibraryFilter>) => setF((x) => ({ ...x, ...p }));

  const drill = (entries: LangEntry[]) => {
    setDeck(
      entries.map((e) => {
        const s = foreignSide(e);
        return { key: newKey("d"), english: s.english, target: s.text, phonetic: e.phonetic_guide ?? "", lang: s.lang, entryId: e.id };
      }),
    );
    const first = entries[0] && foreignSide(entries[0]).lang;
    setPrefs({ view: "learn", ...(first && first !== "en" ? { trackLang: first } : {}) });
  };

  const bulkDelete = async () => {
    setBusy(true);
    try {
      await deleteEntries([...sel]);
      setSel(new Set());
      setSelecting(false);
    } catch (e) {
      toastError("Delete failed", e);
    } finally {
      setBusy(false);
      setConfirmBulk(false);
    }
  };

  return (
    <div className="space-y-3">
      <section className="glass space-y-2.5 r-20 p-3 md:p-4" aria-label="Search and filters">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <Input value={f.q} onChange={(e) => up({ q: e.target.value })} placeholder="Search original or translation…" aria-label="Search the Library" className="!h-11 !pl-9" type="search" />
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]" role="group" aria-label="Language">
          <Chip active={!f.lang} onClick={() => up({ lang: null })}>
            All languages
          </Chip>
          {langs.map((l) => (
            <Chip key={l} active={f.lang === l} onClick={() => up({ lang: f.lang === l ? null : l })}>
              {langName(l)}
            </Chip>
          ))}
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]" role="group" aria-label="Category and status">
          {CATEGORIES.map((c) => (
            <Chip key={c.id} tone="teal" active={f.category === c.id} onClick={() => up({ category: f.category === c.id ? null : c.id })}>
              {c.label}
            </Chip>
          ))}
          <Chip active={f.favorites} onClick={() => up({ favorites: !f.favorites })}>
            ★ Favorites
          </Chip>
          {MASTERY.map((m) => (
            <Chip key={m.id} active={f.mastery === m.id} onClick={() => up({ mastery: f.mastery === m.id ? null : m.id })}>
              {m.label}
            </Chip>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2 px-1">
        <span className="rounded-full bg-[rgba(11,13,17,0.6)] px-2.5 py-1 font-mono fs-11 text-ink-2 backdrop-blur-md">
          {rows.length} of {library.length}
        </span>
        {rows.length > 0 && !compact && (
          <button type="button" onClick={() => drill(rows.slice(0, 30))} className="pill-glass !h-8 text-xs">
            <Layers size={12} /> Drill these
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setSelecting((s) => !s);
            setSel(new Set());
            setConfirmBulk(false);
          }}
          aria-pressed={selecting}
          className="pill-glass ml-auto !h-8 text-xs"
        >
          {selecting ? <X size={12} /> : <CheckSquare size={12} />} {selecting ? "Cancel" : "Select"}
        </button>
        {selecting && (
          <>
            <button type="button" onClick={() => setSel(new Set(rows.map((r) => r.id)))} className="pill-glass !h-8 text-xs">
              All shown
            </button>
            {confirmBulk ? (
              <span className="flex items-center gap-1.5 text-xs text-alert">
                Delete {sel.size} permanently?
                <button type="button" disabled={busy} onClick={() => void bulkDelete()} className="pill-glass !h-8 !border-alert/50 text-xs !text-alert">
                  {busy ? <Loader2 size={12} className="animate-spin" /> : "Yes, delete"}
                </button>
                <button type="button" onClick={() => setConfirmBulk(false)} className="pill-glass !h-8 text-xs">
                  No
                </button>
              </span>
            ) : (
              <button type="button" disabled={!sel.size} onClick={() => setConfirmBulk(true)} className="pill-glass !h-8 text-xs !text-alert disabled:opacity-40">
                <Trash2 size={12} /> Delete ({sel.size})
              </button>
            )}
          </>
        )}
      </div>

      {libraryError && (
        <p role="alert" className="r-14 border border-alert/40 bg-alert/10 p-3 text-sm text-alert">
          Library unavailable: {libraryError}{" "}
          <button type="button" className="underline" onClick={() => void loadAll()}>
            Retry
          </button>
        </p>
      )}
      {!libraryLoaded ? (
        <div className="grid min-h-32 place-items-center text-sm text-ink-3">
          <Loader2 className="animate-spin" size={16} />
        </div>
      ) : rows.length === 0 ? (
        <div className="glass grid min-h-32 place-items-center r-20 p-6 text-center text-sm text-ink-3">
          {library.length ? "Nothing matches these filters." : "Saved translations, captures and lesson phrases land here."}
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((e) => (
            <EntryRow
              key={e.id}
              e={e}
              selecting={selecting}
              selected={sel.has(e.id)}
              onSelect={() =>
                setSel((s) => {
                  const n = new Set(s);
                  if (n.has(e.id)) n.delete(e.id);
                  else n.add(e.id);
                  return n;
                })
              }
              onDrill={() => drill([e])}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function EntryRow({ e, selecting, selected, onSelect, onDrill }: { e: LangEntry; selecting: boolean; selected: boolean; onSelect: () => void; onDrill: () => void }) {
  const { updateEntry, deleteEntries } = useHub();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(e.context_note ?? "");
  const [confirm, setConfirm] = useState(false);
  const foreign = foreignSide(e);
  const cat = CATEGORIES.find((c) => c.id === e.category)?.label ?? e.category;
  const patch = (p: Parameters<typeof updateEntry>[1]) => void updateEntry(e.id, p).catch((err) => toastError("Couldn't update", err));

  return (
    <li className={`glass r-18 p-3.5 ${selected ? "border-amber/60" : ""}`}>
      <div className="flex items-start gap-2.5">
        {selecting && (
          <button type="button" onClick={onSelect} aria-label={selected ? "Deselect" : "Select"} aria-pressed={selected} className="mt-0.5 text-amber-light">
            {selected ? <CheckSquare size={18} /> : <Square size={18} />}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5 fs-10.5">
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono uppercase tracking-wider text-ink-2">
              {langName(e.source_lang)} → {langName(e.target_lang)}
            </span>
            <span className="text-ink-3">{cat}</span>
            <span className="text-ink-3">· {new Date(e.timestamp).toLocaleDateString()}</span>
          </div>
          <p className="fs-13 text-ink-2">{e.source_text}</p>
          <p className="fs-16 font-semibold leading-snug text-ink">{e.translated_text}</p>
          {e.phonetic_guide && <p className="font-mono fs-12 text-amber-soft">{e.phonetic_guide}</p>}
          {editing ? (
            <form
              className="mt-1.5 flex gap-1.5"
              onSubmit={(ev) => {
                ev.preventDefault();
                patch({ context_note: note });
                setEditing(false);
              }}
            >
              <Input value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={500} autoFocus aria-label="Note" placeholder="e.g. Heard at coffee shop" className="!h-9 min-w-0 flex-1 fs-13" />
              <button type="submit" className="pill-primary !h-9 text-xs">
                Save
              </button>
            </form>
          ) : (
            e.context_note && <p className="mt-1 fs-12 italic text-ink-3">“{e.context_note}”</p>
          )}
        </div>
        <button type="button" onClick={() => patch({ favorite: !e.favorite })} aria-label={e.favorite ? "Unfavorite" : "Favorite"} aria-pressed={e.favorite} className={e.favorite ? "text-amber-light" : "text-ink-3 hover:text-ink"}>
          <Star size={17} fill={e.favorite ? "currentColor" : "none"} />
        </button>
      </div>
      {!selecting && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <PlayButton text={foreign.text} lang={foreign.lang} label={`Replay ${langName(foreign.lang)}`} />
          <button type="button" onClick={() => setEditing((x) => !x)} aria-label="Edit note" title="Edit note" className="pill-glass !h-8 !w-8 !p-0">
            <Pencil size={13} />
          </button>
          <button type="button" onClick={onDrill} className="pill-glass !h-8 text-xs" title="Send to Practice Drill">
            <Layers size={12} /> Drill
          </button>
          <Select value={e.mastery_status} onChange={(ev) => patch({ mastery_status: ev.target.value as Mastery })} aria-label="Mastery" className="!h-8 !w-auto !py-0 fs-12">
            {MASTERY.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
          {confirm ? (
            <span className="ml-auto flex items-center gap-1.5 text-xs text-alert">
              Delete permanently?
              <button type="button" onClick={() => void deleteEntries([e.id]).catch((err) => toastError("Delete failed", err))} className="pill-glass !h-8 !border-alert/50 text-xs !text-alert">
                Delete
              </button>
              <button type="button" onClick={() => setConfirm(false)} className="pill-glass !h-8 text-xs">
                Keep
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirm(true)} aria-label="Delete" title="Delete" className="pill-glass ml-auto !h-8 !w-8 !p-0 hover:!text-alert">
              <Trash2 size={13} />
            </button>
          )}
        </div>
      )}
    </li>
  );
}
