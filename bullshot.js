const { Wallet } = require('ethers');
const fs = require('fs');
const readline = require('readline');

const BASE_URL = 'https://gemapi.bullshot.io';
const REF_CODE = '0x413c3593';
const LOGIN_DELAY = 2000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getHeaders(address = '', token = '') {
  return {
    'Content-Type': 'application/json',
    'Origin': 'https://gem.bullshot.io',
    'Referer': 'https://gem.bullshot.io/',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    ...(address ? { 'X-Wallet-Address': address } : {}),
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

async function api(method, path, body, address, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
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
  } finally {
    clearTimeout(timeout);
  }
}

async function connectWallet(privateKey) {
  const wallet = new Wallet(privateKey.trim());
  const address = wallet.address;

  console.log(`\n[+] Processing: ${address}`);

  const ban = await api('GET', `/api/user/check-ban/${address}`, null, address);
  if (ban.banned || ban.isBanned) { console.log(`[!] BANNED, skip`); return null; }

  const { message } = await api('POST', '/api/auth/nonce', { walletAddress: address }, address);
  const signature = await wallet.signMessage(message);

  const { token, user } = await api('POST', '/api/auth/login', {
    walletAddress: address, message, signature, refCode: REF_CODE,
  }, address);

  console.log(`[✓] Login OK | ${user.username} | Gems: ${user.gems} | Energy: ${user.energy}/${user.energyCapacity}`);
  return { address, token, user };
}

function pickBestLocation(locations, energy, miningPower) {
  const unlocked = locations.filter(l =>
    !l.isLocked &&
    l.energyCost <= energy &&
    l.miningPowerRequired <= miningPower
  );
  if (!unlocked.length) return null;
  // Pilih yang GEMS reward tertinggi
  return unlocked.sort((a, b) =>
    (b.rewardRanges?.GEMS?.max || 0) - (a.rewardRanges?.GEMS?.max || 0)
  )[0];
}

async function mineLoop(session) {
  const { address, token } = session;
  const tag = `[${address.slice(0, 8)}...]`;

  console.log(`\n${tag} Starting mine loop...`);

  const locations = await api('GET', '/api/mining/locations', null, address, token);

  while (true) {
    try {
      // Cek stats
      const stats = await api('GET', '/api/mining/stats', null, address, token);
      console.log(`${tag} Energy: ${stats.energy} | ActivePos: ${stats.activePositions} | TotalMined: ${stats.totalMined}`);

      // Cek active positions
      const positions = await api('GET', '/api/mining/positions', null, address, token);

      // Collect yang sudah selesai
      for (const pos of positions) {
        if (pos.status === 'completed' || (pos.remainingSeconds !== undefined && pos.remainingSeconds <= 0)) {
          try {
            const collected = await api('POST', `/api/mining/positions/${pos.id}/collect`, null, address, token);
            console.log(`${tag} [✓] Collected: ${pos.locationName} | Rewards: ${JSON.stringify(collected?.rewards || collected)}`);
          } catch (e) {
            console.log(`${tag} [!] Collect failed: ${e.message}`);
          }
        }
      }

      // Cek active yang masih jalan
      const active = positions.filter(p => p.status === 'active' && p.remainingSeconds > 0);
      if (active.length > 0) {
        const soonest = active.sort((a, b) => a.remainingSeconds - b.remainingSeconds)[0];
        const waitSec = soonest.remainingSeconds + 5;
        console.log(`${tag} Mining at ${soonest.locationName} | Done in ${soonest.remainingSeconds}s → wait ${waitSec}s`);
        await sleep(waitSec * 1000);
        continue;
      }

      // Refresh stats setelah collect
      const freshStats = await api('GET', '/api/mining/stats', null, address, token);

      // Start mine baru
      const loc = pickBestLocation(locations, freshStats.energy, freshStats.miningPower);
      if (!loc) {
        console.log(`${tag} [!] No location available (energy: ${freshStats.energy}), wait 60s...`);
        await sleep(60000);
        continue;
      }

      const started = await api('POST', '/api/mining/positions', { locationId: loc.id }, address, token);
      console.log(`${tag} [⛏] Started: ${loc.name || loc.id} | Duration: ${loc.durationSeconds}s | Energy cost: ${loc.energyCost}`);

      await sleep((loc.durationSeconds + 5) * 1000);

    } catch (e) {
      console.error(`${tag} [!] Error: ${e.message} — retry in 30s`);
      await sleep(30000);
    }
  }
}

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, ans => { rl.close(); res(ans.trim()); }));
}

async function main() {
  const keys = fs.readFileSync('wallet.txt', 'utf-8')
    .split('\n').map(l => l.trim()).filter(Boolean);

  console.log(`[*] Total wallets: ${keys.length}`);
  console.log(`\nPilih mode:`);
  console.log(`  1. 1 akun (pilih index)`);
  console.log(`  2. Semua akun`);
  console.log(`  3. From X to end`);

  const mode = await prompt('\nPilihan (1/2/3): ');

  let selectedKeys = [];

  if (mode === '1') {
    const idx = parseInt(await prompt(`Nomor akun (1-${keys.length}): `));
    selectedKeys = [keys[idx - 1]];
  } else if (mode === '2') {
    selectedKeys = keys;
  } else if (mode === '3') {
    const from = parseInt(await prompt(`Mulai dari akun nomor (1-${keys.length}): `));
    selectedKeys = keys.slice(from - 1);
    console.log(`[*] Running wallet ${from} → ${keys.length}`);
  } else {
    console.log('[!] Invalid'); process.exit(1);
  }

  // Login semua dulu
  console.log(`\n[*] Logging in ${selectedKeys.length} wallet(s)...`);
  const sessions = [];
  for (const key of selectedKeys) {
    try {
      const s = await connectWallet(key);
      if (s) sessions.push(s);
    } catch (e) {
      console.error(`[!] Login error: ${e.message}`);
    }
    await sleep(LOGIN_DELAY);
  }

  console.log(`\n[*] ${sessions.length}/${selectedKeys.length} logged in. Starting mining...`);

  // Jalankan semua parallel
  await Promise.all(sessions.map(s => mineLoop(s)));
}

main().catch(console.error);
