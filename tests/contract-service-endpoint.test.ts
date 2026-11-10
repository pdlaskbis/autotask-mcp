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

describe('createContractServiceAdjustment', () => {
  /** First call is the adjustment POST (itemId: null), second is the unit read-back query. */
  function mockAdjustmentThenUnits(unitRows: unknown[]): jest.SpyInstance {
    const ok = (body: unknown) =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
      }) as unknown as Response;
    return jest
      .spyOn(global, 'fetch' as any)
      .mockResolvedValueOnce(ok({ itemId: null }))
      .mockResolvedValueOnce(ok({ items: unitRows, pageDetails: { nextPageUrl: null } }));
  }

  it('POSTs to /ContractServiceAdjustments, tolerates itemId: null, and reads the units back', async () => {
    const fetchMock = mockAdjustmentThenUnits([
      { contractServiceID: 6875, units: 13, price: 64.87, startDate: '2026-12-01T00:00:00.000Z' },
    ]);
    const service = new AutotaskService(config, logger);

    const res = await service.createContractServiceAdjustment({
      contractID: 30246025,
      contractServiceID: 6875,
      effectiveDate: '2026-12-01',
      unitChange: 13,
      adjustedUnitPrice: 4.99,
      adjustedUnitCost: 1.74,
    });

    const routes = calledRoutes(fetchMock);
    expect(routes[0]).toBe('POST /ATServicesRest/v1.0/ContractServiceAdjustments');
    expect(routes[1]).toBe('POST /ATServicesRest/v1.0/ContractServiceUnits/query');
    expect(firstRequestBody(fetchMock)).toEqual({
      contractID: 30246025,
      contractServiceID: 6875,
      effectiveDate: '2026-12-01',
      unitChange: 13,
      adjustedUnitPrice: 4.99,
      adjustedUnitCost: 1.74,
      allowRepeatService: false,
    });
    expect(res.units[0]).toMatchObject({ units: 13, price: 64.87 });
  });

  it.each([
    [{ contractServiceID: 6875, effectiveDate: '2026-12-01', unitChange: 13 }, /contractID is required/],
    [{ contractID: 30246025, effectiveDate: '2026-12-01', unitChange: 13 }, /contractServiceID is required/],
    [{ contractID: 30246025, contractServiceID: 6875, effectiveDate: '2026-12-01', unitChange: 0 }, /non-zero whole number/],
    [{ contractID: 30246025, contractServiceID: 6875, effectiveDate: '2026-12-01', unitChange: 1.5 }, /non-zero whole number/],
    [{ contractID: 30246025, contractServiceID: 6875, effectiveDate: '12/01/2026', unitChange: 13 }, /YYYY-MM-DD/],
  ])('rejects %p before calling Autotask', async (args, err) => {
    const fetchMock = mockFetchOk({});
    const service = new AutotaskService(config, logger);
    await expect(service.createContractServiceAdjustment(args as any)).rejects.toThrow(err);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
