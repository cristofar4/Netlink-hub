import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Input, StatusDot } from '@netlink/ui';
import {
  formatBytes,
  type AgentSummary,
  type ApprovedFolder,
  type SpaceSummary,
  type Transfer,
} from '@netlink/contracts';
import { api, ApiError } from '../lib/api';
import { useBrandName } from '../state/brand';
import './files.css';

/**
 * Files.
 *
 * Only folders the owner approved appear here. There is no path in this screen
 * that browses a whole drive, because there is no such endpoint — the agent
 * refuses anything that resolves outside an approved folder.
 *
 * Transfers are brokered: the control plane authorises and records them, and
 * the bytes move directly between the owner's own devices.
 */
export function FilesScreen({ space }: { space: SpaceSummary | null }) {
  const brand = useBrandName();
  const [folders, setFolders] = useState<ApprovedFolder[] | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ folderId: string; path: string } | null>(
    null,
  );

  const load = useCallback(async () => {
    if (!space) return;
    try {
      const [folderList, transferList] = await Promise.all([
        api.listFolders(space.id),
        api.listTransfers(space.id, 15),
      ]);
      setFolders(folderList);
      setTransfers(transferList);
      setError(null);
    } catch (caught) {
      setFolders([]);
      setError(caught instanceof ApiError ? caught.message : 'Could not load your files.');
    }

    if (space.isOwner) {
      try {
        setAgents(await api.listAgents(space.id));
      } catch {
        // Not fatal — the add-folder form simply will not offer a computer.
      }
    }
  }, [space]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!space) return <Card>Select a Space first.</Card>;
  if (folders === null) return <Card>Loading…</Card>;

  return (
    <div className="nl-stack" style={{ gap: 20 }}>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && !error && <Alert tone="success">{notice}</Alert>}

      <Alert tone="info">
        Only the folders you approve are visible in {brand}. Your whole drive is never exposed, and
        file contents never pass through — or rest on — {brand}&rsquo;s servers.
      </Alert>

      {folders.length === 0 ? (
        <Card>
          <EmptyState
            title="No folders approved"
            description={
              space.isOwner
                ? 'Approve a folder on one of your computers to make it reachable.'
                : 'The owner of this Space has not shared any folders with you.'
            }
            action={
              space.isOwner ? (
                <Button variant="primary" onClick={() => setAdding(true)}>
                  Approve a folder
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        folders.map((folder) => (
          <Card
            key={folder.resourceId}
            title={folder.name}
            subtitle={`${folder.target} · on ${folder.agentName}`}
            actions={
              <div className="nl-row" style={{ gap: 10, flexWrap: 'wrap' }}>
                {folder.readOnly && <Badge tone="warning">Read only</Badge>}
                <StatusDot
                  tone={folder.agentOnline ? 'online' : 'offline'}
                  label={folder.agentOnline ? 'Reachable' : 'Computer offline'}
                />
              </div>
            }
          >
            <FolderActions
              space={space}
              folder={folder}
              onNotice={async (message) => {
                setNotice(message);
                await load();
              }}
              onError={setError}
              onRequestDelete={(path) => setConfirmDelete({ folderId: folder.resourceId, path })}
            />

            {confirmDelete?.folderId === folder.resourceId && (
              <div className="files__confirm">
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  Delete “{confirmDelete.path}”?
                </div>
                <div style={{ fontSize: 'var(--nl-text-sm)', lineHeight: 1.6 }}>
                  This permanently removes it from that computer. {brand} cannot undo it, and it
                  does not go to the Recycle Bin.
                </div>
                <div className="nl-row" style={{ gap: 8, marginTop: 14 }}>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={async () => {
                      try {
                        await api.fileOperation(space.id, {
                          resourceId: confirmDelete.folderId,
                          operation: 'delete',
                          path: confirmDelete.path,
                          confirmed: true,
                        });
                        setConfirmDelete(null);
                        setNotice(`Asked ${folder.agentName} to delete “${confirmDelete.path}”.`);
                        await load();
                      } catch (caught) {
                        setError(
                          caught instanceof ApiError ? caught.message : 'That delete was refused.',
                        );
                      }
                    }}
                  >
                    Yes, delete it
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                    Keep it
                  </Button>
                </div>
              </div>
            )}
          </Card>
        ))
      )}

      {space.isOwner && folders.length > 0 && !adding && (
        <div>
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Approve another folder
          </Button>
        </div>
      )}

      {adding && space.isOwner && (
        <ApproveFolderCard
          spaceId={space.id}
          agents={agents}
          onCancel={() => setAdding(false)}
          onApproved={async (name) => {
            setAdding(false);
            setNotice(`“${name}” is now shared.`);
            await load();
          }}
        />
      )}

      {transfers.length > 0 && (
        <Card title="Recent transfers" subtitle="Every transfer is recorded — never its contents.">
          <ul className="nl-stack" style={{ gap: 12, listStyle: 'none', padding: 0, margin: 0 }}>
            {transfers.map((transfer) => (
              <li key={transfer.id} className="files__transfer">
                <Badge
                  tone={
                    transfer.state === 'completed'
                      ? 'success'
                      : transfer.state === 'failed'
                        ? 'danger'
                        : transfer.state === 'active'
                          ? 'cyan'
                          : 'neutral'
                  }
                >
                  {transfer.direction === 'download' ? 'Download' : 'Upload'}
                </Badge>
                <span style={{ fontSize: 'var(--nl-text-sm)', minWidth: 0, flex: '1 1 200px' }}>
                  {transfer.path}
                </span>
                <span className="nl-dim" style={{ fontSize: 'var(--nl-text-xs)' }}>
                  {formatBytes(transfer.transferredBytes)}
                  {transfer.sizeBytes && ` of ${formatBytes(transfer.sizeBytes)}`}
                  {transfer.checksum && ' · verified'}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function FolderActions({
  space,
  folder,
  onNotice,
  onError,
  onRequestDelete,
}: {
  space: SpaceSummary;
  folder: ApprovedFolder;
  onNotice: (message: string) => Promise<void>;
  onError: (message: string) => void;
  onRequestDelete: (path: string) => void;
}) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await run();
      await onNotice(`${label} requested on ${folder.agentName}.`);
      setPath('');
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : `${label} was refused.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="nl-stack" style={{ gap: 14 }}>
      <Input
        label="File or folder inside this approved folder"
        value={path}
        onChange={(event) => setPath(event.target.value)}
        placeholder="reports/2026/summary.pdf"
        hint="Relative to the approved folder. Anything outside it is refused by the computer itself."
        disabled={!folder.agentOnline}
      />

      <div className="nl-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button
          variant="primary"
          size="sm"
          disabled={!path.trim() || !folder.agentOnline}
          loading={busy === 'Download'}
          onClick={() =>
            act('Download', () =>
              api.startTransfer(space.id, {
                resourceId: folder.resourceId,
                direction: 'download',
                path: path.trim(),
                offsetBytes: '0',
              }),
            )
          }
        >
          Download
        </Button>

        <Button
          variant="secondary"
          size="sm"
          disabled={!path.trim() || !folder.agentOnline || folder.readOnly}
          loading={busy === 'Upload'}
          onClick={() =>
            act('Upload', () =>
              api.startTransfer(space.id, {
                resourceId: folder.resourceId,
                direction: 'upload',
                path: path.trim(),
                offsetBytes: '0',
              }),
            )
          }
        >
          Upload here
        </Button>

        <Button
          variant="secondary"
          size="sm"
          disabled={!path.trim() || !folder.agentOnline || folder.readOnly}
          loading={busy === 'New folder'}
          onClick={() =>
            act('New folder', () =>
              api.fileOperation(space.id, {
                resourceId: folder.resourceId,
                operation: 'mkdir',
                path: path.trim(),
              }),
            )
          }
        >
          Create folder
        </Button>

        <Button
          variant="danger"
          size="sm"
          disabled={!path.trim() || !folder.agentOnline || folder.readOnly}
          onClick={() => onRequestDelete(path.trim())}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

function ApproveFolderCard({
  spaceId,
  agents,
  onCancel,
  onApproved,
}: {
  spaceId: string;
  agents: AgentSummary[];
  onCancel: () => void;
  onApproved: (name: string) => Promise<void>;
}) {
  const brand = useBrandName();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card
      title="Approve a folder"
      subtitle="Name exactly the folder you want to share. Nothing above or beside it becomes reachable."
    >
      <form
        className="nl-stack"
        style={{ gap: 16 }}
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          setBusy(true);
          try {
            await api.approveFolder(spaceId, {
              agentId,
              name: name.trim(),
              path: path.trim(),
              readOnly,
            });
            await onApproved(name.trim());
          } catch (caught) {
            setError(
              caught instanceof ApiError ? caught.message : 'Could not approve that folder.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {agents.length === 0 ? (
          <Alert tone="warning">
            No computer has joined this Space yet. Connect the {brand} agent first.
          </Alert>
        ) : (
          <label className="nl-field">
            <span className="nl-field__label">Computer</span>
            <select
              className="nl-input"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              disabled={busy}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.status !== 'online' ? ' (offline)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        <Input
          label={`Name in ${brand}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Documents"
          disabled={busy}
        />

        <Input
          label="Folder on that computer"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="C:\Users\You\Documents"
          hint="The full path. Only this folder and what is inside it becomes reachable."
          disabled={busy}
        />

        <label className="files__check">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(event) => setReadOnly(event.target.checked)}
            disabled={busy}
          />
          <span>
            Share read-only
            <span className="files__hint">
              Files can be browsed and downloaded, never changed or deleted.
            </span>
          </span>
        </label>

        {error && <Alert tone="error">{error}</Alert>}

        <div className="nl-row" style={{ gap: 8 }}>
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={!agentId || !name.trim() || !path.trim()}
          >
            Approve
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
