// Simple test to verify encode-admin integration works
const axios = require('axios');

const ENCODE_ADMIN_API_URL = 'https://encode-admin.fly.dev/api';
const ENCODE_ADMIN_API_KEY = 'e9aaae3945ba3937b04feeb14de0c407';

async function testCreateVideo() {
  try {
    console.log('Testing video creation...');
    const response = await axios({
      method: 'POST',
      url: `${ENCODE_ADMIN_API_URL}/user/videos`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ENCODE_ADMIN_API_KEY}`,
      },
      data: {
        name: 'Test Video',
        sourceLink: 'https://example.com/test-video.mp4'
      },
    });

    console.log('Video created successfully:', response.data);
    return response.data.id;
  } catch (error) {
    console.error('Failed to create video:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
    return null;
  }
}

async function testUpdateVideoSourceLink(videoId) {
  try {
    console.log(`Testing video source link update for ID: ${videoId}...`);
    const response = await axios({
      method: 'PUT',
      url: `${ENCODE_ADMIN_API_URL}/user/videos/${videoId}/source-link`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ENCODE_ADMIN_API_KEY}`,
      },
      data: {
        sourceLink: 'https://example.com/updated-video.mp4'
      },
    });

    console.log('Video source link updated successfully:', response.data);
    return true;
  } catch (error) {
    console.error('Failed to update video source link:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
    return false;
  }
}

async function runTests() {
  console.log('Starting encode-admin API tests...\n');
  
  // Test 1: Create a video
  const videoId = await testCreateVideo();
  
  if (videoId) {
    console.log('\n');
    // Test 2: Update video source link
    await testUpdateVideoSourceLink(videoId);
  }
  
  console.log('\nTests completed!');
}

runTests();