import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

interface RequestStore {
  ipAddress: string | undefined;
}

const storage = new AsyncLocalStorage<RequestStore>();

@Injectable()
export class RequestContextService {
  run(store: RequestStore, fn: () => void) {
    storage.run(store, fn);
  }

  getIp(): string | undefined {
    return storage.getStore()?.ipAddress;
  }
}
