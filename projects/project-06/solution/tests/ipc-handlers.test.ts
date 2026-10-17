import * as path from 'path';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerIpcHandlers } from '../src/main/ipc-handlers';
import { IPC_CHANNELS } from '../src/shared/types';
import { createServices, makeTempDir, removeDir, Services, writeSourceFile } from './helpers';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

/** Stands in for Electron's ipcMain: records handlers and lets tests invoke them. */
class FakeIpcMain {
  handlers = new Map<string, Handler>();

  handle(channel: string, handler: Handler): void {
    if (this.handlers.has(channel)) throw new Error(`Duplicate handler for ${channel}`);
    this.handlers.set(channel, handler);
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({}, ...args);
  }
}

let root: string;
let s: Services;
let ipc: FakeIpcMain;

beforeEach(() => {
  root = makeTempDir();
  s = createServices(path.join(root, 'data'));
  ipc = new FakeIpcMain();
  registerIpcHandlers(ipc as unknown as IpcMain, s);
});

afterEach(() => removeDir(root));

describe('registerIpcHandlers', () => {
  it('registers exactly one handler per channel in IPC_CHANNELS', () => {
    expect([...ipc.handlers.keys()].sort()).toEqual(Object.values(IPC_CHANNELS).sort());
  });

  it('routes import, list, get and delete to DocumentService', async () => {
    const source = writeSourceFile(root, 'a.md', 'Alpha');
    const doc = (await ipc.invoke(IPC_CHANNELS.IMPORT_DOCUMENT, source)) as { id: string };

    expect(await ipc.invoke(IPC_CHANNELS.LIST_DOCUMENTS)).toEqual([doc]);
    expect(await ipc.invoke(IPC_CHANNELS.GET_DOCUMENT, doc.id)).toEqual(doc);
    expect(await ipc.invoke(IPC_CHANNELS.DELETE_DOCUMENT, doc.id)).toBe(true);
    expect(await ipc.invoke(IPC_CHANNELS.LIST_DOCUMENTS)).toEqual([]);
  });

  it('propagates import errors to the renderer as a rejected promise', async () => {
    await expect(ipc.invoke(IPC_CHANNELS.IMPORT_DOCUMENT, path.join(root, 'ghost.md'))).rejects.toThrow(/File not found/);
  });

  it('routes indexing, status and chunks to IndexingService', async () => {
    const doc = s.documentService.importDocument(writeSourceFile(root, 'a.md', 'Alpha'));

    expect(await ipc.invoke(IPC_CHANNELS.START_INDEXING)).toMatchObject({ status: 'ready' });
    expect(await ipc.invoke(IPC_CHANNELS.GET_INDEXING_STATUS)).toMatchObject({ currentIndexed: 1 });
    expect(await ipc.invoke(IPC_CHANNELS.GET_STATUS)).toMatchObject({ totalDocuments: 1 });
    expect(await ipc.invoke(IPC_CHANNELS.GET_CHUNKS, doc.id)).toHaveLength(1);
  });

  it('routes feedback and history to QaService', async () => {
    await ipc.invoke(IPC_CHANNELS.SUBMIT_FEEDBACK, 't', 'q', 'positive');

    expect(await ipc.invoke(IPC_CHANNELS.GET_FEEDBACK)).toMatchObject([{ rating: 'positive', comment: '' }]);
    expect(await ipc.invoke(IPC_CHANNELS.GET_HISTORY)).toEqual([]);
  });

  it('RESET_DATA clears every data file', async () => {
    s.documentService.importDocument(writeSourceFile(root, 'a.md', 'Alpha'));
    await s.indexingService.startIndexing();
    s.qaService.submitFeedback('t', 'q', 'positive');

    expect(await ipc.invoke(IPC_CHANNELS.RESET_DATA)).toEqual({ success: true });
    expect(await ipc.invoke(IPC_CHANNELS.LIST_DOCUMENTS)).toEqual([]);
    expect(await ipc.invoke(IPC_CHANNELS.GET_FEEDBACK)).toEqual([]);
    expect(await ipc.invoke(IPC_CHANNELS.GET_STATUS)).toMatchObject({ status: 'idle', currentIndexed: 0 });
  });
});
