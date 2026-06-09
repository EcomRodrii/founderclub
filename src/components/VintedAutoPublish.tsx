import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Upload, X, Check, AlertTriangle, Loader2, Send,
  RefreshCw, Plus, Trash2, Zap, Wifi, WifiOff,
  ChevronDown, Image as ImageIcon,
} from 'lucide-react';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface VintedAccount {
  id: number;
  username: string;
  domain: string;
  vinted_id: string | null;
  is_active: boolean;
  updated_at: string;
}

type ListingStatus = 'draft' | 'publishing' | 'published' | 'failed';

interface Listing {
  id: number;
  title: string;
  description?: string;
  price: number;
  condition: string;
  brand: string;
  size: string;
  gender: string;
  package_size: string;
  images: string[];
  status: ListingStatus;
  vinted_id: string | null;
  created_at: string;
}

interface LogEntry {
  type: 'log' | 'done' | 'error';
  step?: string;
  message: string;
  screenshot?: string; // data:image/jpeg;base64,...
}

interface FormState {
  title: string;
  description: string;
  price: string;
  condition: string;
  brand: string;
  size: string;
  gender: string;
  package_size: string;
  images: string[]; // base64 data URLs
}

const EMPTY_FORM: FormState = {
  title: '',
  description: '',
  price: '',
  condition: 'tres_bon',
  brand: '',
  size: 'sin_especificar',
  gender: 'hombre',
  package_size: 'S',
  images: [],
};

const CONDITIONS = [
  { value: 'neuf_etiquette', label: 'Nuevo con etiqueta' },
  { value: 'neuf_sans_etiquette', label: 'Nuevo sin etiqueta' },
  { value: 'tres_bon', label: 'Muy buen estado' },
  { value: 'bon', label: 'Buen estado' },
  { value: 'acceptable', label: 'Aceptable' },
];

const EU_SIZES = [
  '35', '36', '37', '38', '39', '40', '41', '42', '43',
  '44', '45', '46', '47', '48', '49', '50',
];

const PACKAGE_SIZES = [
  { value: 'S', label: 'S (≤2kg)' },
  { value: 'M', label: 'M (≤5kg)' },
  { value: 'L', label: 'L (≤10kg)' },
];

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function statusBadge(status: ListingStatus) {
  switch (status) {
    case 'draft':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-white/[0.06] text-[#888880]">
          Borrador
        </span>
      );
    case 'publishing':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-yellow-500/10 text-yellow-400">
          <Loader2 className="w-3 h-3 animate-spin" />
          Publicando…
        </span>
      );
    case 'published':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-[#d4ff00]/10 text-[#d4ff00]">
          <Check className="w-3 h-3" />
          Publicado
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-red-500/10 text-red-400">
          <X className="w-3 h-3" />
          Error
        </span>
      );
  }
}

// ─────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────

interface ImageDropZoneProps {
  images: string[];
  onChange: (images: string[]) => void;
}

function ImageDropZone({ images, onChange }: ImageDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files) return;
    const remaining = 8 - images.length;
    if (remaining <= 0) return;
    const accepted = Array.from(files)
      .filter(f => f.type.startsWith('image/'))
      .slice(0, remaining);
    const encoded = await Promise.all(accepted.map(fileToBase64));
    onChange([...images, ...encoded]);
  }

  return (
    <div className="space-y-3">
      <div
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
          dragging
            ? 'border-[#d4ff00]/60 bg-[#d4ff00]/5'
            : 'border-white/[0.12] hover:border-white/20'
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <ImageIcon className="w-7 h-7 mx-auto mb-2 text-[#888880]" />
        <p className="text-sm text-[#888880]">
          Arrastra fotos aquí o{' '}
          <span className="text-[#d4ff00]">selecciona archivos</span>
        </p>
        <p className="text-xs text-[#888880]/60 mt-1">Máx. 8 fotos · JPG, PNG, WEBP</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={e => handleFiles(e.target.files)}
        />
      </div>
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((src, i) => (
            <div key={i} className="relative group">
              <img
                src={src}
                alt=""
                className="w-20 h-20 object-cover rounded-xl border border-white/[0.08]"
              />
              <button
                type="button"
                onClick={() => onChange(images.filter((_, j) => j !== i))}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[#111111] border border-white/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="w-3 h-3 text-[#f2f2ef]" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// Log Panel
// ─────────────────────────────────────────────

interface LogPanelProps {
  logs: LogEntry[];
  isStreaming: boolean;
  onClose: () => void;
}

function LogPanel({ logs, isStreaming, onClose }: LogPanelProps) {
  const [expandedScreenshot, setExpandedScreenshot] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  const lastEntry = logs[logs.length - 1];
  const isDone = !isStreaming && lastEntry && (lastEntry.type === 'done' || lastEntry.type === 'error');

  return (
    <>
      {/* Expanded screenshot overlay */}
      {expandedScreenshot && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setExpandedScreenshot(null)}
        >
          <img
            src={expandedScreenshot}
            alt="Screenshot"
            className="max-w-full max-h-full rounded-xl border border-white/20"
          />
        </div>
      )}

      <div className="mt-6 bg-[#161616] border border-white/[0.08] rounded-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.08]">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-[#d4ff00]" />
            <span className="text-sm font-semibold text-[#f2f2ef]">Log de publicación</span>
            {isStreaming && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#888880]" />}
          </div>
          {!isStreaming && (
            <button
              onClick={onClose}
              className="text-xs text-[#888880] hover:text-[#f2f2ef] transition-colors"
            >
              Cerrar
            </button>
          )}
        </div>

        {/* Entries */}
        <div className="p-4 space-y-2 max-h-72 overflow-y-auto text-sm font-mono">
          {logs.map((entry, i) => (
            <div
              key={i}
              className={`flex flex-col gap-1.5 ${
                entry.type === 'error'
                  ? 'text-red-400'
                  : entry.type === 'done'
                  ? 'text-[#d4ff00]'
                  : 'text-[#888880]'
              }`}
            >
              <div className="flex items-start gap-2">
                {entry.type === 'log' && (
                  <span className="shrink-0 w-1.5 h-1.5 mt-1.5 rounded-full bg-[#888880]" />
                )}
                {entry.type === 'done' && <Check className="shrink-0 w-3.5 h-3.5 mt-0.5" />}
                {entry.type === 'error' && <X className="shrink-0 w-3.5 h-3.5 mt-0.5" />}
                <span>
                  {entry.step && (
                    <span className="text-[#f2f2ef]/50 mr-1">[{entry.step}]</span>
                  )}
                  {entry.message}
                </span>
              </div>
              {entry.screenshot && (
                <img
                  src={entry.screenshot}
                  alt="screenshot"
                  className="ml-5 w-40 h-auto rounded-lg border border-white/10 cursor-pointer hover:border-[#d4ff00]/40 transition-colors"
                  onClick={() => setExpandedScreenshot(entry.screenshot!)}
                />
              )}
            </div>
          ))}
          {isStreaming && (
            <div className="flex items-center gap-2 text-[#888880]">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Esperando respuesta…</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Final banner */}
        {isDone && (
          <div
            className={`px-5 py-3 border-t border-white/[0.08] text-sm font-medium ${
              lastEntry.type === 'done'
                ? 'bg-[#d4ff00]/10 text-[#d4ff00]'
                : 'bg-red-500/10 text-red-400'
            }`}
          >
            {lastEntry.type === 'done' ? (
              <span className="flex items-center gap-2">
                <Check className="w-4 h-4" /> {lastEntry.message}
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> {lastEntry.message}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────

interface VintedAutoPublishProps {
  token: string;
}

export default function VintedAutoPublish({ token }: VintedAutoPublishProps) {
  const [accounts, setAccounts] = useState<VintedAccount[]>([]);
  const [listings, setListings] = useState<Listing[]>([]);
  const [activeTab, setActiveTab] = useState<'drafts' | 'new'>('drafts');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [publishingId, setPublishingId] = useState<number | null>(null);
  const [publishLogs, setPublishLogs] = useState<Map<number, LogEntry[]>>(new Map());
  const [isStreaming, setIsStreaming] = useState(false);
  const [logListingId, setLogListingId] = useState<number | null>(null);
  const [loadingListings, setLoadingListings] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  // ── Fetch accounts ──
  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/vinted/accounts', { headers: authHeaders });
      if (!res.ok) return;
      const data = await res.json();
      setAccounts(data.accounts ?? []);
    } catch {
      // silently ignore
    }
  }, [token]);

  // ── Fetch listings ──
  const fetchListings = useCallback(async () => {
    setLoadingListings(true);
    try {
      const res = await fetch('/api/autopublish/listings', { headers: authHeaders });
      if (!res.ok) return;
      const data = await res.json();
      setListings(data.listings ?? []);
    } catch {
      // silently ignore
    } finally {
      setLoadingListings(false);
    }
  }, [token]);

  useEffect(() => {
    fetchAccounts();
    fetchListings();
  }, [fetchAccounts, fetchListings]);

  // ── Latest account ──
  const latestAccount = accounts.length
    ? [...accounts].sort(
        (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      )[0]
    : null;

  // ── Form helpers ──
  function patchForm(patch: Partial<FormState>) {
    setForm(prev => ({ ...prev, ...patch }));
  }

  function startCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setActiveTab('new');
  }

  function startEdit(listing: Listing) {
    setEditingId(listing.id);
    setForm({
      title: listing.title,
      description: listing.description ?? '',
      price: String(listing.price),
      condition: listing.condition,
      brand: listing.brand,
      size: listing.size,
      gender: listing.gender,
      package_size: listing.package_size,
      images: listing.images ?? [],
    });
    setActiveTab('new');
  }

  // ── Save draft ──
  async function saveDraft(): Promise<number | null> {
    setSaving(true);
    try {
      const body = {
        title: form.title,
        description: form.description,
        price: parseFloat(form.price) || 0,
        condition: form.condition,
        brand: form.brand,
        size: form.size,
        gender: form.gender,
        package_size: form.package_size,
        images: form.images,
      };

      if (editingId !== null) {
        const res = await fetch(`/api/autopublish/listings/${editingId}`, {
          method: 'PUT',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('Failed to update');
        await fetchListings();
        return editingId;
      } else {
        const res = await fetch('/api/autopublish/listings', {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('Failed to create');
        const data = await res.json();
        await fetchListings();
        return data.listing?.id ?? null;
      }
    } catch {
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveDraft() {
    const id = await saveDraft();
    if (id !== null) {
      setEditingId(null);
      setForm(EMPTY_FORM);
      setActiveTab('drafts');
    }
  }

  // ── Delete listing ──
  async function deleteListing(id: number) {
    if (!confirm('¿Eliminar este borrador?')) return;
    try {
      await fetch(`/api/autopublish/listings/${id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      await fetchListings();
    } catch {
      // silently ignore
    }
  }

  // ── Publish via SSE-over-fetch ──
  async function publishListing(id: number) {
    // If editing, save first
    if (activeTab === 'new') {
      await saveDraft();
    }

    setPublishingId(id);
    setLogListingId(id);
    setPublishLogs(prev => new Map(prev).set(id, []));
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await fetch(`/api/autopublish/listings/${id}/publish`, {
        method: 'POST',
        headers: authHeaders,
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const dataLine = part.split('\n').find(l => l.startsWith('data:'));
          if (!dataLine) continue;
          try {
            const event: LogEntry = JSON.parse(dataLine.slice(5));
            setPublishLogs(prev => {
              const next = new Map(prev);
              next.set(id, [...(next.get(id) ?? []), event]);
              return next;
            });
          } catch {
            // ignore malformed
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setPublishLogs(prev => {
          const next = new Map(prev);
          next.set(id, [
            ...(next.get(id) ?? []),
            { type: 'error', message: String(err) },
          ]);
          return next;
        });
      }
    } finally {
      setIsStreaming(false);
      setPublishingId(null);
      abortRef.current = null;
      await fetchListings();
    }
  }

  async function handlePublishNow() {
    let id = editingId;
    if (id === null) {
      id = await saveDraft();
    } else {
      await saveDraft();
    }
    if (id === null) return;
    setActiveTab('drafts');
    await publishListing(id);
  }

  // ── Render ──
  const draftCount = listings.filter(l => l.status === 'draft' || l.status === 'failed').length;
  const logsForPanel = logListingId !== null ? publishLogs.get(logListingId) ?? [] : [];

  return (
    <div className="space-y-6">
      {/* ── Connection Status ── */}
      <div className="bg-[#161616] border border-white/[0.08] rounded-2xl p-5">
        {latestAccount ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative">
                <Wifi className="w-5 h-5 text-[#f2f2ef]" />
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-[#f2f2ef]">
                  Conectado ·{' '}
                  <span className="text-[#d4ff00]">@{latestAccount.username}</span> ·{' '}
                  {latestAccount.domain}
                </p>
                <p className="text-xs text-[#888880]">
                  Sesión actualizada:{' '}
                  {new Date(latestAccount.updated_at).toLocaleString('es-ES', {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
            </div>
            <button
              onClick={() => { fetchAccounts(); fetchListings(); }}
              className="p-2 rounded-xl bg-white/[0.05] hover:bg-white/[0.08] text-[#888880] hover:text-[#f2f2ef] transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <WifiOff className="w-5 h-5 text-orange-400 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-orange-400">
                No detectada sesión de Vinted
              </p>
              <p className="text-xs text-[#888880]">
                Abre vinted.es con la extensión activa para sincronizar las cookies.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-2">
        <button
          onClick={() => setActiveTab('drafts')}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
            activeTab === 'drafts'
              ? 'bg-[#d4ff00] text-black'
              : 'bg-white/[0.05] hover:bg-white/[0.08] text-[#f2f2ef]'
          }`}
        >
          📋 Borradores
          {draftCount > 0 && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded-full font-semibold ${
                activeTab === 'drafts' ? 'bg-black/20 text-black' : 'bg-white/10 text-[#f2f2ef]'
              }`}
            >
              {draftCount}
            </span>
          )}
        </button>
        <button
          onClick={startCreate}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
            activeTab === 'new'
              ? 'bg-[#d4ff00] text-black'
              : 'bg-white/[0.05] hover:bg-white/[0.08] text-[#f2f2ef]'
          }`}
        >
          <Plus className="w-4 h-4" />
          Nuevo anuncio
        </button>
      </div>

      {/* ── Drafts List ── */}
      {activeTab === 'drafts' && (
        <div className="space-y-4">
          {loadingListings && (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-6 h-6 animate-spin text-[#888880]" />
            </div>
          )}

          {!loadingListings && listings.length === 0 && (
            <div className="bg-[#161616] border border-white/[0.08] rounded-2xl p-8 text-center">
              <ImageIcon className="w-10 h-10 mx-auto mb-3 text-[#888880]/40" />
              <p className="text-sm text-[#888880]">No hay anuncios guardados.</p>
              <button
                onClick={startCreate}
                className="mt-4 bg-[#d4ff00] hover:bg-[#b3da00] text-black font-semibold rounded-xl px-5 py-2.5 text-sm transition-colors"
              >
                Crear primer anuncio
              </button>
            </div>
          )}

          {!loadingListings && listings.map(listing => (
            <div key={listing.id}>
              <div className="bg-[#161616] border border-white/[0.08] rounded-2xl p-5">
                <div className="flex items-start gap-4">
                  {/* Thumbnail */}
                  {listing.images?.[0] ? (
                    <img
                      src={listing.images[0]}
                      alt=""
                      className="w-16 h-16 object-cover rounded-xl border border-white/[0.08] shrink-0"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center shrink-0">
                      <ImageIcon className="w-6 h-6 text-[#888880]/40" />
                    </div>
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[#f2f2ef] truncate">
                          {listing.title || '(sin título)'}
                        </p>
                        <p className="text-xs text-[#888880] mt-0.5">
                          {listing.brand && <span className="mr-2">{listing.brand}</span>}
                          {listing.size !== 'sin_especificar' && (
                            <span className="mr-2">Talla {listing.size}</span>
                          )}
                          <span className="font-semibold text-[#f2f2ef]">
                            {listing.price.toFixed(2)} €
                          </span>
                        </p>
                      </div>
                      {statusBadge(listing.status)}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 mt-3">
                      {(listing.status === 'draft' || listing.status === 'failed') && (
                        <button
                          onClick={() => publishListing(listing.id)}
                          disabled={publishingId !== null}
                          className="inline-flex items-center gap-1.5 bg-[#d4ff00] hover:bg-[#b3da00] disabled:opacity-50 disabled:cursor-not-allowed text-black font-semibold rounded-xl px-4 py-2 text-xs transition-colors"
                        >
                          {publishingId === listing.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Zap className="w-3.5 h-3.5" />
                          )}
                          Publicar ahora
                        </button>
                      )}
                      <button
                        onClick={() => startEdit(listing)}
                        className="inline-flex items-center gap-1.5 bg-white/[0.05] hover:bg-white/[0.08] text-[#f2f2ef] rounded-xl px-4 py-2 text-xs transition-colors"
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => deleteListing(listing.id)}
                        className="inline-flex items-center gap-1 bg-white/[0.05] hover:bg-red-500/10 hover:text-red-400 text-[#888880] rounded-xl px-3 py-2 text-xs transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Log panel for this listing */}
              {logListingId === listing.id && (publishLogs.get(listing.id)?.length ?? 0) > 0 && (
                <LogPanel
                  logs={publishLogs.get(listing.id) ?? []}
                  isStreaming={isStreaming && publishingId === listing.id}
                  onClose={() => setLogListingId(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Create / Edit Form ── */}
      {activeTab === 'new' && (
        <div className="bg-[#161616] border border-white/[0.08] rounded-2xl p-5 space-y-5">
          <h2 className="text-lg font-bold text-[#f2f2ef]">
            {editingId !== null ? 'Editar anuncio' : 'Nuevo anuncio'}
          </h2>

          {/* Fotos */}
          <div>
            <label className="block text-xs font-medium text-[#888880] mb-2">Fotos</label>
            <ImageDropZone
              images={form.images}
              onChange={images => patchForm({ images })}
            />
          </div>

          {/* Título */}
          <div>
            <label className="block text-xs font-medium text-[#888880] mb-2">Título</label>
            <input
              type="text"
              value={form.title}
              onChange={e => patchForm({ title: e.target.value })}
              placeholder="Ej: Nike Air Max 90 talla 42"
              className="w-full bg-[#1c1c1c] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-[#f2f2ef] placeholder-[#888880]/50 focus:outline-none focus:border-[#d4ff00]/40 transition-colors"
            />
          </div>

          {/* Descripción */}
          <div>
            <label className="block text-xs font-medium text-[#888880] mb-2">Descripción</label>
            <textarea
              rows={4}
              value={form.description}
              onChange={e => patchForm({ description: e.target.value })}
              placeholder="Describe el artículo, talla real, defectos, etc."
              className="w-full bg-[#1c1c1c] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-[#f2f2ef] placeholder-[#888880]/50 focus:outline-none focus:border-[#d4ff00]/40 transition-colors resize-none"
            />
          </div>

          {/* Precio + Marca */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-[#888880] mb-2">Precio</label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.price}
                  onChange={e => patchForm({ price: e.target.value })}
                  placeholder="0.00"
                  className="w-full bg-[#1c1c1c] border border-white/[0.08] rounded-xl px-4 py-2.5 pr-8 text-sm text-[#f2f2ef] placeholder-[#888880]/50 focus:outline-none focus:border-[#d4ff00]/40 transition-colors"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[#888880]">€</span>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#888880] mb-2">Marca</label>
              <input
                type="text"
                value={form.brand}
                onChange={e => patchForm({ brand: e.target.value })}
                placeholder="Nike, Adidas, New Balance…"
                className="w-full bg-[#1c1c1c] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-[#f2f2ef] placeholder-[#888880]/50 focus:outline-none focus:border-[#d4ff00]/40 transition-colors"
              />
            </div>
          </div>

          {/* Talla + Estado */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-[#888880] mb-2">Talla</label>
              <div className="relative">
                <select
                  value={form.size}
                  onChange={e => patchForm({ size: e.target.value })}
                  className="w-full appearance-none bg-[#1c1c1c] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-[#f2f2ef] focus:outline-none focus:border-[#d4ff00]/40 transition-colors"
                >
                  <option value="sin_especificar">Sin especificar</option>
                  {EU_SIZES.map(s => (
                    <option key={s} value={s}>EU {s}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#888880] pointer-events-none" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#888880] mb-2">Estado</label>
              <div className="relative">
                <select
                  value={form.condition}
                  onChange={e => patchForm({ condition: e.target.value })}
                  className="w-full appearance-none bg-[#1c1c1c] border border-white/[0.08] rounded-xl px-4 py-2.5 text-sm text-[#f2f2ef] focus:outline-none focus:border-[#d4ff00]/40 transition-colors"
                >
                  {CONDITIONS.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#888880] pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Género */}
          <div>
            <label className="block text-xs font-medium text-[#888880] mb-2">Género</label>
            <div className="flex gap-2">
              {[
                { value: 'hombre', label: 'Hombre' },
                { value: 'mujer', label: 'Mujer' },
              ].map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => patchForm({ gender: opt.value })}
                  className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                    form.gender === opt.value
                      ? 'bg-[#d4ff00] text-black'
                      : 'bg-white/[0.05] hover:bg-white/[0.08] text-[#f2f2ef]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Envío */}
          <div>
            <label className="block text-xs font-medium text-[#888880] mb-2">Envío</label>
            <div className="flex gap-2">
              {PACKAGE_SIZES.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => patchForm({ package_size: opt.value })}
                  className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                    form.package_size === opt.value
                      ? 'bg-[#d4ff00] text-black'
                      : 'bg-white/[0.05] hover:bg-white/[0.08] text-[#f2f2ef]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Buttons */}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={handleSaveDraft}
              disabled={saving}
              className="inline-flex items-center gap-2 bg-white/[0.05] hover:bg-white/[0.08] disabled:opacity-50 text-[#f2f2ef] rounded-xl px-5 py-2.5 text-sm font-medium transition-colors"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Guardar borrador
            </button>
            <button
              type="button"
              onClick={handlePublishNow}
              disabled={saving || publishingId !== null || !form.title || !form.price}
              className="inline-flex items-center gap-2 bg-[#d4ff00] hover:bg-[#b3da00] disabled:opacity-50 disabled:cursor-not-allowed text-black font-semibold rounded-xl px-5 py-2.5 text-sm transition-colors"
            >
              {saving || publishingId !== null ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              Publicar ahora →
            </button>
            {editingId !== null && (
              <button
                type="button"
                onClick={() => { setEditingId(null); setForm(EMPTY_FORM); setActiveTab('drafts'); }}
                className="inline-flex items-center gap-1 text-xs text-[#888880] hover:text-[#f2f2ef] transition-colors ml-auto"
              >
                <X className="w-3.5 h-3.5" />
                Cancelar
              </button>
            )}
          </div>

          {/* Inline log panel when publishing from form */}
          {logListingId !== null && activeTab === 'new' && (publishLogs.get(logListingId)?.length ?? 0) > 0 && (
            <LogPanel
              logs={publishLogs.get(logListingId) ?? []}
              isStreaming={isStreaming}
              onClose={() => setLogListingId(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}
