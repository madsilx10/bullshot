const { Wallet } = require('ethers');
const fs = require('fs');

const BASE_URL = 'https://gemapi.bullshot.io';
const REF_CODE = '0x413c3593';
const DELAY = 2000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getHeaders(address = '') {
  return {
    'Content-Type': 'application/json',
    'Origin': 'https://gem.bullshot.io',
    'Referer': 'https://gem.bullshot.io/',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    ...(address ? { 'X-Wallet-Address': address } : {}),
  };
}

async function api(method, path, body, address) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: getHeaders(address),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || res.statusText);
  return data;
}

async function connectWallet(privateKey) {
  const wallet = new Wallet(privateKey.trim());
  const address = wallet.address;

  console.log(`\n[+] Processing: ${address}`);

  // Step 1: Check ban
  const ban = await api('GET', `/api/user/check-ban/${address}`, null, address);
  if (ban.banned || ban.isBanned) {
    console.log(`[!] BANNED, skip`);
    return null;
  }
  console.log(`[✓] Not banned`);

  // Step 2: Get nonce
  const { message } = await api('POST', '/api/auth/nonce', { walletAddress: address }, address);
  console.log(`[✓] Nonce: ${message}`);

  // Step 3: Sign
  const signature = await wallet.signMessage(message);
  console.log(`[✓] Signed`);

  // Step 4: Login
  const { token, user } = await api('POST', '/api/auth/login', {
    walletAddress: address,
    message,
    signature,
    refCode: REF_CODE,
  }, address);

  console.log(`[✓] Login OK | User: ${user.username} | Gems: ${user.gems} | Energy: ${user.energy}`);
  return { address, token, user };
}

async function main() {
  const keys = fs.readFileSync('wallet.txt', 'utf-8')
    .split('\n').map(l => l.trim()).filter(Boolean);

  console.log(`[*] Total wallets: ${keys.length}`);

  const sessions = [];
  for (const key of keys) {
    try {
      const session = await connectWallet(key);
      if (session) sessions.push(session);
    } catch (e) {
      console.error(`[!] Error: ${e.message}`);
    }
    await sleep(DELAY);
  }

  console.log(`\n[*] Done: ${sessions.length}/${keys.length} connected`);
  return sessions;
}

main();
