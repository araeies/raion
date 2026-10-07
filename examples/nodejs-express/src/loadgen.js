// Steady synthetic traffic against payment-api, so dashboards, SLOs and alerts have data.
//   TARGET=http://payment-api:3000  RPS=5
const target = process.env.TARGET ?? 'http://payment-api:3000';
const rps = Math.max(0.1, Number(process.env.RPS ?? 5));
const accounts = ['acc-001', 'acc-002', 'acc-003', 'acc-004'];
const recent = [];
let sent = 0;
let failed = 0;

async function tick() {
  try {
    if (recent.length > 0 && Math.random() < 0.3) {
      const id = recent[Math.floor(Math.random() * recent.length)];
      const res = await fetch(`${target}/payments/${id}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) failed++;
    } else {
      const res = await fetch(`${target}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          account: accounts[Math.floor(Math.random() * accounts.length)],
          amount: Math.round(Math.random() * 10000) / 100 + 1,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const { id } = await res.json();
        recent.push(id);
        if (recent.length > 100) recent.shift();
      } else {
        failed++;
      }
    }
  } catch {
    failed++;
  }
  sent++;
}

setInterval(() => void tick(), 1000 / rps);
setInterval(() => {
  console.log(JSON.stringify({ msg: 'load generator', sent, failed }));
}, 30_000);
console.log(JSON.stringify({ msg: `sending ${rps} requests/s to ${target}` }));
