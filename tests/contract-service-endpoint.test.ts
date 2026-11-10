// Regression tests for the contract-service 404: createContractService() and
// updateContractService() hit the top-level /ContractServices route, which
// Autotask does not expose for writes -- it returns an IIS HTML 404 on every
// call. ContractServices are a child of Contracts: writes go to
// POST/PATCH /Contracts/{contractID}/Services. Seen live 2026-11-10 adding
// Rampart ATP to contract 30246025; the same payload sent as
// POST /Contracts/30246025/Services succeeded (itemId 6875).

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');

const config: McpServerConfig = {
  name: 'test-server',
  version: '0.0.0',
  autotask: {
    username: 'user@example.com',
    secret: 'secret',
    integrationCode: 'integration-code',
    apiUrl: 'https://webservices2.autotask.net/ATServicesRest/',
  },
};

function mockFetchOk(body: unknown): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

function calledRoutes(fetchMock: jest.SpyInstance): string[] {
  return fetchMock.mock.calls.map(
    (c: any[]) => `${(c[1] as RequestInit).method} ${new URL(c[0] as string).pathname}`
  );
}

function firstRequestBody(fetchMock: jest.SpyInstance): any {
  return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
}

beforeEach(() => {
  _resetZoneUrlCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createContractService', () => {
  it('POSTs to /Contracts/{contractID}/Services, not /ContractServices', async () => {
    const fetchMock = mockFetchOk({ itemId: 6875 });
    const service = new AutotaskService(config, logger);

    const id = await service.createContractService({
      contractID: 30246025,
      serviceID: 300,
      unitPrice: 4.99,
      unitCost: 1.74,
    });

    expect(id).toBe(6875);
    const routes = calledRoutes(fetchMock);
    expect(routes).toContain('POST /ATServicesRest/v1.0/Contracts/30246025/Services');
    expect(routes.some((r) => r.includes('/ContractServices'))).toBe(false);
    expect(firstRequestBody(fetchMock)).toMatchObject({
      contractID: 30246025,
      serviceID: 300,
      unitPrice: 4.99,
    });
  });

  it('rejects a payload without contractID before calling Autotask', async () => {
    const fetchMock = mockFetchOk({ itemId: 1 });
    const service = new AutotaskService(config, logger);

    await expect(
      service.createContractService({ serviceID: 300, unitPrice: 4.99 })
    ).rejects.toThrow(/contractID is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('updateContractService', () => {
  it('PATCHes /Contracts/{contractID}/Services with the id in the body', async () => {
    const fetchMock = mockFetchOk({ itemId: 6875 });
    const service = new AutotaskService(config, logger);

    await service.updateContractService(6875, { contractID: 30246025, unitPrice: 5.25 });

    const routes = calledRoutes(fetchMock);
    expect(routes).toContain('PATCH /ATServicesRest/v1.0/Contracts/30246025/Services');
    expect(routes.some((r) => r.includes('/ContractServices'))).toBe(false);
    expect(firstRequestBody(fetchMock)).toMatchObject({ id: 6875, contractID: 30246025, unitPrice: 5.25 });
  });

  it('rejects an update without contractID before calling Autotask', async () => {
    const fetchMock = mockFetchOk({});
    const service = new AutotaskService(config, logger);

    await expect(service.updateContractService(6875, { unitPrice: 5.25 })).rejects.toThrow(
      /contractID is required/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
