// Replace these with your actual credentials
const CLIENT_ID = 'YOUR_CLIENT_ID_HERE';
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
const SCOPE = 'https://www.googleapis.com/auth/drive';

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${CLIENT_ID}&` +
  `redirect_uri=${REDIRECT_URI}&` +
  `response_type=code&` +
  `scope=${encodeURIComponent(SCOPE)}&` +
  `access_type=offline&` +
  `prompt=consent`;

console.log('Visit this URL to authorize:');
console.log(authUrl);
console.log('\nAfter authorization, you\'ll get a code. Use it to get tokens.');