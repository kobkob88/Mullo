// Fresh in-memory database with the audit log installed and a local owner.

import { useDriver } from '../app/core/db.js';
import { createMemoryDriver } from '../app/core/drivers/memory.js';
import { installAudit } from '../app/core/audit.js';
import { setSession, localOwnerSession } from '../app/core/auth.js';
import { disk } from '../app/core/disk.js';

export function freshDb() {
  const driver = createMemoryDriver();
  useDriver(driver);
  setSession(localOwnerSession());
  installAudit();
  disk.remove('echo:audit-queue');
  return driver;
}

export const seg = (text, start_ms = 0, end_ms = start_ms + 2000, speaker = null) => ({ text, start_ms, end_ms, speaker });
