import assert from 'node:assert/strict';
import test from 'node:test';
import UpstoxOptionChargesClient from '../modules/options/client/upstox-option-charges.client';
import { OptionRoundTripChargesRequestDto } from '../modules/options/dto/option-round-trip-charges.dto';
import { UpstoxOptionChargesDto, UpstoxOptionChargesRequestDto } from '../modules/options/dto/upstox-option-charges.dto';
import OptionRoundTripChargesService from '../modules/options/services/option-round-trip-charges.service';

class ChargesClientMock {
  readonly calls: UpstoxOptionChargesRequestDto[] = [];

  constructor(private readonly responder: (request: UpstoxOptionChargesRequestDto) => Promise<UpstoxOptionChargesDto>) {}

  async fetchCharges(request: UpstoxOptionChargesRequestDto): Promise<UpstoxOptionChargesDto> {
    this.calls.push(request);
    return this.responder(request);
  }
}

function createCharges(overrides: Partial<UpstoxOptionChargesDto> = {}): UpstoxOptionChargesDto {
  return {
    brokerage: 20,
    stt: 5,
    exchangeTransactionCharges: 2,
    sebiCharges: 1,
    gst: 4,
    stampDuty: 1.5,
    otherCharges: 0.5,
    reportedTotalCharges: 34,
    ...overrides,
  };
}

function createRequest(overrides: Partial<OptionRoundTripChargesRequestDto> = {}): OptionRoundTripChargesRequestDto {
  return {
    instrumentKey: 'NSE_FO|35271',
    quantity: 50,
    product: 'I',
    entryPrice: 100,
    exitPrice: 120,
    ...overrides,
  };
}

function createService(responder: (request: UpstoxOptionChargesRequestDto) => Promise<UpstoxOptionChargesDto>): {
  service: OptionRoundTripChargesService;
  client: ChargesClientMock;
} {
  const client = new ChargesClientMock(responder);
  return {
    service: new OptionRoundTripChargesService(client as unknown as UpstoxOptionChargesClient),
    client,
  };
}

test('aggregates successful BUY entry and SELL exit charges', async () => {
  const { service, client } = createService((request) => Promise.resolve(createCharges({ brokerage: request.transactionType === 'BUY' ? 20 : 25 })));

  const result = await service.calculate(createRequest());

  assert.deepEqual(client.calls.map((call) => call.transactionType), ['BUY', 'SELL']);
  assert.equal(result.entryCharges.brokerage, 20);
  assert.equal(result.exitCharges.brokerage, 25);
});

test('aggregates brokerage charges', async () => {
  const { service } = createService((request) => Promise.resolve(createCharges({ brokerage: request.transactionType === 'BUY' ? 20 : 25 })));

  const result = await service.calculate(createRequest());

  assert.equal(result.combinedCharges.brokerage, 45);
});

test('aggregates STT charges', async () => {
  const { service } = createService((request) => Promise.resolve(createCharges({ stt: request.transactionType === 'BUY' ? 5 : 7 })));

  const result = await service.calculate(createRequest());

  assert.equal(result.combinedCharges.stt, 12);
});

test('aggregates GST charges', async () => {
  const { service } = createService((request) => Promise.resolve(createCharges({ gst: request.transactionType === 'BUY' ? 4 : 6 })));

  const result = await service.calculate(createRequest());

  assert.equal(result.combinedCharges.gst, 10);
});

test('aggregates exchange, SEBI, and stamp-duty charges', async () => {
  const { service } = createService((request) => Promise.resolve(createCharges({
    exchangeTransactionCharges: request.transactionType === 'BUY' ? 2 : 3,
    sebiCharges: request.transactionType === 'BUY' ? 1 : 1.5,
    stampDuty: request.transactionType === 'BUY' ? 1.5 : 0,
  })));

  const result = await service.calculate(createRequest());

  assert.equal(result.combinedCharges.exchangeTransactionCharges, 5);
  assert.equal(result.combinedCharges.sebiCharges, 2.5);
  assert.equal(result.combinedCharges.stampDuty, 1.5);
});

test('aggregates other charges', async () => {
  const { service } = createService((request) => Promise.resolve(createCharges({ otherCharges: request.transactionType === 'BUY' ? 0.5 : 0.75 })));

  const result = await service.calculate(createRequest());

  assert.equal(result.combinedCharges.otherCharges, 1.25);
});

test('calculates the combined mapped total charges', async () => {
  const { service } = createService(() => Promise.resolve(createCharges()));

  const result = await service.calculate(createRequest());

  assert.equal(result.totalCharges, 68);
});

test('reports exact reconciliation when broker totals match mapped charges', async () => {
  const { service } = createService(() => Promise.resolve(createCharges()));

  const result = await service.calculate(createRequest());

  assert.equal(result.combinedReportedTotal, 68);
  assert.equal(result.reconciliationDifference, 0);
});

test('preserves a reconciliation mismatch', async () => {
  const { service } = createService(() => Promise.resolve(createCharges({ reportedTotalCharges: 35 })));

  const result = await service.calculate(createRequest());

  assert.equal(result.combinedReportedTotal, 70);
  assert.equal(result.reconciliationDifference, 2);
});

test('propagates a BUY API failure without calling SELL', async () => {
  const buyError = new Error('BUY quote failed');
  const { service, client } = createService(() => Promise.reject(buyError));

  await assert.rejects(() => service.calculate(createRequest()), (error: unknown) => error === buyError);
  assert.equal(client.calls.length, 1);
});

test('propagates a SELL API failure after the BUY call', async () => {
  const sellError = new Error('SELL quote failed');
  const { service, client } = createService((request) => request.transactionType === 'BUY'
    ? Promise.resolve(createCharges())
    : Promise.reject(sellError));

  await assert.rejects(() => service.calculate(createRequest()), (error: unknown) => error === sellError);
  assert.deepEqual(client.calls.map((call) => call.transactionType), ['BUY', 'SELL']);
});

test('does not mutate the supplied request', async () => {
  const { service } = createService(() => Promise.resolve(createCharges()));
  const request = createRequest();
  const original = structuredClone(request);

  await service.calculate(request);

  assert.deepEqual(request, original);
});
