const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// OAuth2 scopes needed for Google Drive
const SCOPES = ['https://www.googleapis.com/auth/drive'];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function generateAuth() {
  console.log('\n=== Google Drive OAuth2 Setup ===\n');
  console.log('To set up Google Drive authentication, you need to:');
  console.log('1. Go to https://console.cloud.google.com/');
  console.log('2. Create a new project or select existing one');
  console.log('3. Enable Google Drive API');
  console.log('4. Create OAuth2 credentials (Desktop application type)');
  console.log('5. Download the credentials JSON\n');

  const clientId = await question('Enter your Google Client ID: ');
  const clientSecret = await question('Enter your Google Client Secret: ');

  const oauth2Client = new OAuth2Client(
    clientId.trim(),
    clientSecret.trim(),
    'urn:ietf:wg:oauth:2.0:oob'
  );

  // Generate the authorization URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('\nAuthorize this app by visiting this URL:');
  console.log(authUrl);
  console.log('\n');

  const code = await question('Enter the authorization code from that page: ');

  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    
    console.log('\n=== Success! ===\n');
    console.log('Add these environment variables to your .env file:\n');
    console.log(`GOOGLE_CLIENT_ID=${clientId.trim()}`);
    console.log(`GOOGLE_CLIENT_SECRET=${clientSecret.trim()}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    
    // Optionally save to .env file
    const saveToEnv = await question('\nDo you want to append these to your .env file? (y/n): ');
    
    if (saveToEnv.toLowerCase() === 'y') {
      const envPath = path.join(__dirname, '..', '.env');
      const envContent = `\n# Google Drive OAuth2 Credentials\nGOOGLE_CLIENT_ID=${clientId.trim()}\nGOOGLE_CLIENT_SECRET=${clientSecret.trim()}\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
      
      fs.appendFileSync(envPath, envContent);
      console.log('\nCredentials saved to .env file!');
    }
  } catch (error) {
    console.error('\nError getting tokens:', error.message);
  }

  rl.close();
}

generateAuth().catch(console.error);