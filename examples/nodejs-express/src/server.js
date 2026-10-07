// Example service for Raion. The same image runs two services, selected by SERVICE_ROLE:
//
//   payment-api  POST /payments, GET /payments/:id   (calls ledger-api for every payment)
//   ledger-api   POST /entries,  GET /balances/:account
//
// The code contains NO observability code. Raion connects it to OpenTelemetry through
// environment variables only (zero-code instrumentation); see ../README.md.
//
// Fault injection, for trying out alerts and SLOs:
//   FAILURE_RATE=0.05   5% of requests fail with HTTP 500
//   SLOW_RATE=0.10      10% of requests take 600-1500 ms
// Both can also be changed at runtime: POST /admin/faults {"failureRate":0.2,"slowRate":0}
import { randomUUID } from 'node:crypto';
import express from 'express';
import pino from 'pino';

const role = process.env.SERVICE_ROLE ?? 'payment-api';
const port = Number(process.env.PORT ?? 3000);
const ledgerUrl = process.env.LEDGER_URL ?? 'http://ledger-api:3000';
const faults = {
  failureRate: Number(process.env.FAILURE_RATE ?? 0),
  slowRate: Number(process.env.SLOW_RATE ?? 0),
};

const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { role } });
const app = express();
app.use(express.json({ limit: '16kb' }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Applies the configured faults to a request. Returns true when the request should fail. */
async function injectFaults() {
  if (Math.random() < faults.slowRate) await sleep(600 + Math.random() * 900);
  else await sleep(5 + Math.random() * 60);
  return Math.random() < faults.failureRate;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', role });
});

app.post('/admin/faults', (req, res) => {
  for (const key of ['failureRate', 'slowRate']) {
    const value = req.body?.[key];
    if (value !== undefined) {
      if (typeof value !== 'number' || value < 0 || value > 1) {
        return res.status(400).json({ error: `${key} must be a number between 0 and 1` });
      }
      faults[key] = value;
    }
  }
  log.warn({ faults }, 'fault injection changed');
  return res.json(faults);
});

// ----- payment-api ---------------------------------------------------------------------
const payments = new Map();

if (role === 'payment-api') {
  app.post('/payments', async (req, res, next) => {
    try {
      const { account, amount } = req.body ?? {};
      if (typeof account !== 'string' || !(Number(amount) > 0)) {
        throw new HttpError(400, 'account (string) and amount (> 0) are required');
      }
      if (await injectFaults()) throw new HttpError(500, 'payment processor unavailable');

      const response = await fetch(`${ledgerUrl}/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account, amount: Number(amount) }),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new HttpError(502, `ledger-api answered ${response.status}`);
      const entry = await response.json();

      const payment = {
        id: randomUUID(),
        account,
        amount: Number(amount),
        entryId: entry.id,
        status: 'settled',
      };
      payments.set(payment.id, payment);
      log.info({ paymentId: payment.id, account, amount: payment.amount }, 'payment settled');
      res.status(201).json(payment);
    } catch (error) {
      next(error);
    }
  });

  app.get('/payments/:id', async (req, res, next) => {
    try {
      if (await injectFaults()) throw new HttpError(500, 'payment store unavailable');
      const payment = payments.get(req.params.id);
      if (!payment) throw new HttpError(404, 'payment not found');
      res.json(payment);
    } catch (error) {
      next(error);
    }
  });
}

// ----- ledger-api ------------------------------------------------------------------------
const balances = new Map();

if (role === 'ledger-api') {
  app.post('/entries', async (req, res, next) => {
    try {
      const { account, amount } = req.body ?? {};
      if (typeof account !== 'string' || !(Number(amount) > 0)) {
        throw new HttpError(400, 'invalid entry');
      }
      if (await injectFaults()) throw new HttpError(500, 'ledger database timeout');
      balances.set(account, (balances.get(account) ?? 0) + Number(amount));
      const entry = { id: randomUUID(), account, amount: Number(amount) };
      log.info({ entryId: entry.id, account }, 'ledger entry recorded');
      res.status(201).json(entry);
    } catch (error) {
      next(error);
    }
  });

  app.get('/balances/:account', (req, res) => {
    res.json({ account: req.params.account, balance: balances.get(req.params.account) ?? 0 });
  });
}

// ----- errors ------------------------------------------------------------------------------
app.use((error, req, res, _next) => {
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) log.error({ err: error, path: req.path }, 'request failed');
  else log.warn({ path: req.path, reason: error.message }, 'request rejected');
  res.status(status).json({ error: error.message });
});

const server = app.listen(port, () => log.info({ port }, `${role} listening`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
