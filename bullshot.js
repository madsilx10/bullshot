const { Wallet } = require('ethers');
const fs = require('fs');
const readline = require('readline');

const BASE_URL = 'https://gemapi.bullshot.io';
const REF_CODE = '0x413c3593';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getHeaders(address = '', token = '') {
  return {
    'Content-Type': 'application/json',
    'Origin': 'https://gem.bullshot.io',
    'Referer': 'https://gem.bullshot.io/',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    ...(address ? { 'X-Wallet-Address': address } : {}),
    ...(token  ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

async function api(method, path, body, address, token) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: getHeaders(address, token),
      signal: controller.signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON: ${text.slice(0, 100)}`); }
    if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
    return data;
  } finally { clearTimeout(to); }
}

async function login(privateKey) {
  const wallet = new Wallet(privateKey.trim());
  const address = wallet.address;

  const ban = await api('GET', `/api/user/check-ban/${address}`, null, address);
  if (ban.banned || ban.isBanned) throw new Error('BANNED');

  const { message } = await api('POST', '/api/auth/nonce', { walletAddress: address }, address);
  const signature = await wallet.signMessage(message);
  const { token, user } = await api('POST', '/api/auth/login', {
    walletAddress: address, message, signature, refCode: REF_CODE,
  }, address);

  return { address, token, user };
}

function pickLocation(locations, energy, miningPower) {
  return locations
    .filter(l => !l.isLocked && l.name && l.durationSeconds >= 600
      && l.energyCost <= energy && l.miningPowerRequired <= miningPower)
    .sort((a, b) => {
      const g = (b.rewardRanges?.GEMS?.max || 0) - (a.rewardRanges?.GEMS?.max || 0);
      return g !== 0 ? g : b.durationSeconds - a.durationSeconds;
    })[0] || null;
}

// ─── MODE 1: MINE ────────────────────────────────────────────────────────────
// Start mining tiap wallet, ga nunggu selesai
async function modeMine(sessions) {
  console.log(`\n[MINE] ${sessions.length} wallet(s)`);
  for (let i = 0; i < sessions.length; i++) {
    const num = `[${i + 1}/${sessions.length}]`;
    try {
      const { address, token, user } = sessions[i];
      console.log(`${num} ${address} | Energy: ${user.energy}/${user.energyCapacity}`);

      const positions = await api('GET', '/api/mining/positions', null, address, token);
      const active = positions.filter(p => p.status === 'active');

      if (active.length > 0) {
        const soonest = active.sort((a, b) => a.remainingSeconds - b.remainingSeconds)[0];
        console.log(`  → Already mining: ${soonest.locationName} | ${soonest.remainingSeconds}s left`);
      } else {
        const locations = await api('GET', '/api/mining/locations', null, address, token);
        let stats = await api('GET', '/api/mining/stats', null, address, token);
        let started = 0;

        while (true) {
          const loc = pickLocation(locations, stats.energy, stats.miningPower);
          if (!loc) {
            if (started === 0) console.log(`  → No location available (energy: ${stats.energy})`);
            break;
          }
          try {
            await api('POST', '/api/mining/positions', { locationId: loc.id }, address, token);
            started++;
            console.log(`  → [${started}] Started: ${loc.name} | ${loc.durationSeconds}s | -${loc.energyCost} energy`);
            stats.energy -= loc.energyCost;
            await sleep(500);
          } catch (e) {
            console.log(`  → Stop: ${e.message}`);
            break;
          }
        }
        if (started > 0) console.log(`  → Total started: ${started} position(s)`);
      }
    } catch (e) {
      console.error(`${num} Error: ${e.message}`);
    }
    await sleep(1500);
  }
  console.log(`\n[MINE] Done.`);
}

// ─── MODE 2: CLAIM ───────────────────────────────────────────────────────────
// Claim semua position yang sudah selesai
async function modeClaim(sessions) {
  console.log(`\n[CLAIM] ${sessions.length} wallet(s)`);
  let totalGems = 0;
  for (let i = 0; i < sessions.length; i++) {
    const num = `[${i + 1}/${sessions.length}]`;
    try {
      const { address, token } = sessions[i];

      const positions = await api('GET', '/api/mining/positions', null, address, token);
      const claimable = positions.filter(p =>
        p.status === 'completed' || (p.remainingSeconds !== undefined && p.remainingSeconds <= 0)
      );

      if (claimable.length === 0) {
        const active = positions.filter(p => p.status === 'active');
        if (active.length > 0) {
          const soonest = active.sort((a, b) => a.remainingSeconds - b.remainingSeconds)[0];
          console.log(`${num} ${address} → Still mining: ${soonest.remainingSeconds}s left`);
        } else {
          console.log(`${num} ${address} → Nothing to claim`);
        }
      } else {
        for (const pos of claimable) {
          const res = await api('POST', `/api/mining/positions/${pos.id}/claim`, null, address, token);
          const gems = res.gemsEarned || 0;
          totalGems += gems;
          console.log(`${num} ${address} → Claimed: ${pos.locationName} | +${gems} GEMS | Rewards: ${res.rewards?.join(', ')}`);
          await sleep(500);
        }
      }
    } catch (e) {
      console.error(`${num} Error: ${e.message}`);
    }
    await sleep(1500);
  }
  console.log(`\n[CLAIM] Done. Total gems earned: ${totalGems}`);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, ans => { rl.close(); res(ans.trim()); }));
}

function selectKeys(keys, mode, from) {
  if (mode === '1') return [keys[from - 1]];
  if (mode === '2') return keys;
  if (mode === '3') return keys.slice(from - 1);
  return keys;
}

async function main() {
  const keys = fs.readFileSync('wallet.txt', 'utf-8')
    .split('\n').map(l => l.trim()).filter(Boolean);

  console.log(`Wallets: ${keys.length}`);
  console.log(`\nAkun:`);
  console.log(`  1. 1 akun`);
  console.log(`  2. Semua`);
  console.log(`  3. From X to end`);

  const scope = await prompt('\nPilih (1/2/3): ');
  let from = 1;
  if (scope === '1') from = parseInt(await prompt(`Nomor akun (1-${keys.length}): `));
  else if (scope === '3') from = parseInt(await prompt(`Mulai dari nomor (1-${keys.length}): `));

  console.log(`\nMode:`);
  console.log(`  1. Mine  - start mining`);
  console.log(`  2. Claim - claim reward`);
  const action = await prompt('\nPilih (1/2): ');
  if (!['1','2'].includes(action)) { console.log('[!] Invalid'); return; }

  const selected = selectKeys(keys, scope, from);
  console.log(`\n→ Login ${selected.length} wallet...`);

  const sessions = [];
  for (let i = 0; i < selected.length; i++) {
    try {
      const s = await login(selected[i]);
      console.log(`[${i + 1}/${selected.length}] ${s.address} | Energy: ${s.user.energy}/${s.user.energyCapacity}`);
      sessions.push(s);
    } catch (e) {
      console.error(`[${i + 1}/${selected.length}] Login error: ${e.message}`);
    }
    await sleep(1500);
  }

  console.log(`\n${sessions.length}/${selected.length} berhasil login`);
  if (action === '1') await modeMine(sessions);
  else await modeClaim(sessions);
}

main().catch(console.error);
