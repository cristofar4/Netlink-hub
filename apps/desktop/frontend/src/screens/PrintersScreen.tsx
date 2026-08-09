import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Input, StatusDot } from '@netlink/ui';
import {
  PAPER_SIZES,
  looksLikePdf,
  type PaperSize,
  type PrintJob,
  type SharedPrinter,
  type SpaceSummary,
} from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import { useBrandName } from '../state/brand';
import './files.css';

/**
 * Printers.
 *
 * A printer becomes reachable only when the owner shares it, and a member
 * needs `printers.use` before they can send anything. Only PDFs are accepted,
 * checked by their magic bytes rather than their name.
 */
export function PrintersScreen({ space }: { space: SpaceSummary | null }) {
  const brand = useBrandName();
  const [printers, setPrinters] = useState<SharedPrinter[] | null>(null);
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [printing, setPrinting] = useState<SharedPrinter | null>(null);

  const load = useCallback(async () => {
    if (!space) return;
    try {
      const [printerList, jobList] = await Promise.all([
        api.listPrinters(space.id),
        api.listPrintJobs(space.id, 15),
      ]);
      setPrinters(printerList);
      setJobs(jobList);
      setError(null);
    } catch (caught) {
      setPrinters([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load printers.');
    }
  }, [space]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!space) return <Card>Select a Space first.</Card>;
  if (printers === null) return <Card>Loading…</Card>;

  return (
    <div className="nl-stack" style={{ gap: 20 }}>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && !error && <Alert tone="success">{notice}</Alert>}

      {printers.length === 0 ? (
        <Card>
          <EmptyState
            title="No printers shared"
            description={
              space.isOwner
                ? 'Printers found on your computers appear on the My Spaces dashboard. Share one there to make it usable here.'
                : 'The owner of this Space has not shared a printer with you.'
            }
          />
        </Card>
      ) : (
        printers.map((printer) => (
          <Card
            key={printer.resourceId}
            title={printer.name}
            subtitle={`on ${printer.agentName}`}
            actions={
              <div className="nl-row" style={{ gap: 10, flexWrap: 'wrap' }}>
                {printer.isDefault && <Badge tone="cyan">Default</Badge>}
                <StatusDot
                  tone={
                    !printer.agentOnline
                      ? 'offline'
                      : printer.status === 'ready'
                        ? 'online'
                        : 'warning'
                  }
                  label={
                    !printer.agentOnline
                      ? 'Computer offline'
                      : printer.status === 'ready'
                        ? 'Ready'
                        : printer.status
                  }
                />
              </div>
            }
          >
            <Button
              variant="primary"
              disabled={!printer.agentOnline || printer.status !== 'ready'}
              onClick={() => setPrinting(printer)}
            >
              Print a PDF
            </Button>
          </Card>
        ))
      )}

      {printing && (
        <PrintDialog
          spaceId={space.id}
          printer={printing}
          onClose={() => setPrinting(null)}
          onSent={async (documentName) => {
            setPrinting(null);
            setNotice(`“${documentName}” was sent to ${printing.name}.`);
            await load();
          }}
        />
      )}

      {jobs.length > 0 && (
        <Card
          title="Recent print jobs"
          subtitle={`${brand} records what was printed and where — never what was in it.`}
        >
          <ul className="nl-stack" style={{ gap: 12, listStyle: 'none', padding: 0, margin: 0 }}>
            {jobs.map((job) => (
              <li key={job.id} className="files__transfer">
                <Badge
                  tone={
                    job.state === 'completed'
                      ? 'success'
                      : job.state === 'failed'
                        ? 'danger'
                        : 'neutral'
                  }
                >
                  {job.state}
                </Badge>
                <span style={{ fontSize: 'var(--nl-text-sm)', minWidth: 0, flex: '1 1 200px' }}>
                  {job.documentName}
                </span>
                <span className="nl-dim" style={{ fontSize: 'var(--nl-text-xs)' }}>
                  {job.printerName} · {job.copies} {job.copies === 1 ? 'copy' : 'copies'} ·{' '}
                  {job.colour ? 'colour' : 'black and white'} · {job.paperSize}
                  {job.detail && ` · ${job.detail}`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/**
 * Choose a PDF, preview it, set the options, send it.
 *
 * The preview is the browser's own PDF viewer pointed at a local blob URL — the
 * document never leaves this machine until Print is pressed.
 */
function PrintDialog({
  spaceId,
  printer,
  onClose,
  onSent,
}: {
  spaceId: string;
  printer: SharedPrinter;
  onClose: () => void;
  onSent: (documentName: string) => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [copies, setCopies] = useState('1');
  const [colour, setColour] = useState(true);
  const [paperSize, setPaperSize] = useState<PaperSize>('A4');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // The object URL is a resource; releasing it stops the blob being pinned in
  // memory for as long as the app is open.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const submit = async () => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const base64 = await readAsBase64(file);

      // Checked here for a quick, clear message; the server checks again and is
      // the one that actually decides.
      if (!looksLikePdf(base64)) {
        setError('That file is not a PDF. Only PDFs can be printed.');
        return;
      }

      await api.submitPrintJob(spaceId, {
        resourceId: printer.resourceId,
        documentBase64: base64,
        documentName: file.name,
        copies: Math.max(Number(copies) || 1, 1),
        colour,
        paperSize,
      });
      await onSent(file.name);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That job was not accepted.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog__scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="print-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="print-title" className="dialog__title">
          Print to {printer.name}
        </h2>

        <div className="nl-stack" style={{ gap: 16 }}>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="nl-visually-hidden"
            onChange={(event) => {
              setError(null);
              setFile(event.target.files?.[0] ?? null);
            }}
          />

          <div className="nl-row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => inputRef.current?.click()} disabled={busy}>
              {file ? 'Choose a different PDF' : 'Choose a PDF'}
            </Button>
            {file && (
              <span className="nl-muted" style={{ fontSize: 'var(--nl-text-sm)' }}>
                {file.name}
              </span>
            )}
          </div>

          {previewUrl && (
            <div className="print__preview">
              <iframe title={`Preview of ${file?.name ?? 'document'}`} src={previewUrl} />
            </div>
          )}

          <div className="dialog__row">
            <Input
              label="Copies"
              type="number"
              min="1"
              max="50"
              value={copies}
              onChange={(event) => setCopies(event.target.value)}
              disabled={busy}
            />
            <label className="nl-field">
              <span className="nl-field__label">Paper size</span>
              <select
                className="nl-input"
                value={paperSize}
                onChange={(event) => setPaperSize(event.target.value as PaperSize)}
                disabled={busy}
              >
                {PAPER_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="files__check">
            <input
              type="checkbox"
              checked={colour}
              onChange={(event) => setColour(event.target.checked)}
              disabled={busy}
            />
            <span>Print in colour</span>
          </label>

          {error && <Alert tone="error">{error}</Alert>}

          <div className="nl-row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!file} onClick={() => void submit()}>
              Print
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Reads a File into base64, without the data-URL prefix. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}
