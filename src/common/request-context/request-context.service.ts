import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

interface RequestStore {
  ipAddress: string | undefined;
  client?: 'web' | 'mobile_ios' | 'mobile_android';
  deviceId?: string;
  userAgent?: string;
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

  getClient(): RequestStore['client'] {
    return storage.getStore()?.client;
  }

  getDeviceId(): string | undefined {
    return storage.getStore()?.deviceId;
  }

  getUserAgent(): string | undefined {
    return storage.getStore()?.userAgent;
  }
}
