import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { RouterLinkStatus } from '../../shared/types';
import { DecoRouterClient, type DecoSnapshot } from './decoClient';

/**
 * Owns the optional connection to the user's router.
 *
 * The password is encrypted with `safeStorage`, which on Windows is DPAPI keyed
 * to the OS user account, on macOS the Keychain, and on Linux the desktop
 * secret service. It is written to the app's own data directory and is only
 * ever sent to the router address the user entered.
 *
 * Everything here is opt-in and the app is fully functional without it; the
 * only thing it adds is knowing which mesh node each client is joined to.
 */

const CREDENTIALS_FILE = 'router-link.bin';

interface StoredCredentials {
  host: string;
  password: string;
}

export class RouterLink {
  private client?: DecoRouterClient;
  private credentials?: StoredCredentials;
  private snapshot?: DecoSnapshot;
  private lastError?: string;
  private connecting = false;

  constructor(private readonly dataDir: string) {}

  private get credentialsPath(): string {
    return path.join(this.dataDir, CREDENTIALS_FILE);
  }

  get status(): RouterLinkStatus {
    return {
      configured: Boolean(this.credentials),
      connected: Boolean(this.client && this.snapshot),
      connecting: this.connecting,
      host: this.credentials?.host,
      nodeCount: this.snapshot?.nodes.length ?? 0,
      clientCount: this.snapshot?.clients.length ?? 0,
      /** True when the router reports which node each client is on. */
      hasAssociations: Boolean(this.snapshot?.clients.some((client) => client.nodeMac)),
      fetchedAt: this.snapshot?.fetchedAt,
      canStoreSecurely: safeStorage.isEncryptionAvailable(),
      error: this.lastError,
    };
  }

  getSnapshot(): DecoSnapshot | undefined {
    return this.snapshot;
  }

  /** Loads previously saved credentials. Does not contact the router. */
  async loadSaved(): Promise<RouterLinkStatus> {
    try {
      if (!safeStorage.isEncryptionAvailable()) return this.status;
      const blob = await readFile(this.credentialsPath);
      const decoded = JSON.parse(safeStorage.decryptString(blob)) as StoredCredentials;
      if (typeof decoded.host === 'string' && typeof decoded.password === 'string') {
        this.credentials = decoded;
      }
    } catch {
      // No saved credentials, or they were written by a different OS user.
    }
    return this.status;
  }

  /**
   * Authenticates and pulls a first snapshot. `remember` decides whether the
   * password is persisted; when false it lives only in this process.
   */
  async connect(host: string, password: string, remember: boolean): Promise<RouterLinkStatus> {
    this.connecting = true;
    this.lastError = undefined;

    try {
      const client = new DecoRouterClient(host);
      await client.login(password);
      const snapshot = await client.snapshot();

      this.client = client;
      this.snapshot = snapshot;
      this.credentials = { host, password };

      if (remember) {
        if (!safeStorage.isEncryptionAvailable()) {
          this.lastError = 'Connected, but this system has no secure store, so the password was not saved.';
        } else {
          await writeFile(
            this.credentialsPath,
            safeStorage.encryptString(JSON.stringify(this.credentials)),
          );
        }
      } else {
        await unlink(this.credentialsPath).catch(() => undefined);
      }
    } catch (error) {
      this.client = undefined;
      this.snapshot = undefined;
      this.lastError = (error as Error).message;
    } finally {
      this.connecting = false;
    }

    return this.status;
  }

  /** Re-reads the client list, logging in again if the session has expired. */
  async refresh(): Promise<RouterLinkStatus> {
    if (!this.credentials) return this.status;

    try {
      if (!this.client) {
        this.client = new DecoRouterClient(this.credentials.host);
        await this.client.login(this.credentials.password);
      }
      this.snapshot = await this.client.snapshot();
      this.lastError = undefined;
    } catch {
      // Sessions expire; one silent re-login before surfacing anything.
      try {
        this.client = new DecoRouterClient(this.credentials.host);
        await this.client.login(this.credentials.password);
        this.snapshot = await this.client.snapshot();
        this.lastError = undefined;
      } catch (error) {
        this.client = undefined;
        this.lastError = (error as Error).message;
      }
    }

    return this.status;
  }

  /** Forgets the router, deleting any stored password. */
  async disconnect(): Promise<RouterLinkStatus> {
    this.client = undefined;
    this.snapshot = undefined;
    this.credentials = undefined;
    this.lastError = undefined;
    await unlink(this.credentialsPath).catch(() => undefined);
    return this.status;
  }
}

export type { DecoSnapshot } from './decoClient';
