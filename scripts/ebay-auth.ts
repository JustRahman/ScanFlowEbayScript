/**
 * One-time helper to obtain an eBay user refresh token.
 *
 * Prerequisites:
 *   1. Set your RuName's "auth accepted URL" to https://localhost:8080/callback
 *   2. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RUNAME env vars
 *
 * Usage:
 *   npm run ebay-auth
 */

import readline from 'node:readline';
import 'dotenv/config';

const CLIENT_ID = process.env.EBAY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || '';
const RUNAME = process.env.EBAY_RUNAME || '';

const OAUTH_SCOPES = 'https://api.ebay.com/oauth/api_scope';
const EBAY_AUTH_URL = 'https://auth.ebay.com/oauth2/authorize';
const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be set.');
  process.exit(1);
}
if (!RUNAME) {
  console.error('Error: EBAY_RUNAME must be set (your eBay redirect URI name).');
  process.exit(1);
}

const consentUrl = `${EBAY_AUTH_URL}?` + new URLSearchParams({
  client_id: CLIENT_ID,
  response_type: 'code',
  redirect_uri: RUNAME,
  scope: OAUTH_SCOPES,
}).toString();

console.log('\n=== eBay OAuth User Token Setup ===\n');
console.log('1. Open this URL in your browser:\n');
console.log(`   ${consentUrl}\n`);
console.log('2. Sign in to eBay and grant access.');
console.log('3. The browser will redirect to a URL that won\'t load (that\'s expected).');
console.log('4. Copy the FULL URL from your browser\'s address bar and paste it below.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the redirect URL here: ', async (redirectUrl) => {
  rl.close();

  let code: string;
  try {
    const url = new URL(redirectUrl.trim());
    code = url.searchParams.get('code') || '';
  } catch {
    console.error('Error: Invalid URL. Make sure you copied the full URL from the address bar.');
    process.exit(1);
  }

  if (!code) {
    console.error('Error: No authorization code found in the URL.');
    process.exit(1);
  }

  console.log('\nExchanging authorization code for tokens...\n');

  try {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(EBAY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: RUNAME,
      }).toString(),
    });

    const data = await tokenRes.json() as Record<string, unknown>;

    if (!tokenRes.ok) {
      console.error('Token exchange failed:', JSON.stringify(data, null, 2));
      process.exit(1);
    }

    const refreshToken = data.refresh_token as string;
    const accessToken = data.access_token as string;
    const refreshExpires = data.refresh_token_expires_in as number;

    console.log('Success!\n');
    console.log(`Access token:  ${accessToken.substring(0, 30)}...`);
    console.log(`Refresh token expires in: ${Math.round(refreshExpires / 86400)} days\n`);
    console.log('=== Add this to your environment (e.g. Railway) ===\n');
    console.log(`EBAY_REFRESH_TOKEN=${refreshToken}\n`);
  } catch (err) {
    console.error('Error exchanging code:', err);
    process.exit(1);
  }
});
