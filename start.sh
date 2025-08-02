#!/bin/bash

# Large file upload optimized Node.js startup script
# Sets optimal memory and performance settings for handling 10GB+ files

# Check if NODE_MAX_OLD_SPACE_SIZE is set, otherwise use default
NODE_MEMORY=${NODE_MAX_OLD_SPACE_SIZE:-8192}

# Node.js performance flags for large file handling
NODE_FLAGS="
  --max-old-space-size=$NODE_MEMORY
  --max-semi-space-size=128
  --initial-heap-size=512
  --optimize-for-size
  --gc-interval=100
"

echo "Starting importer service with optimized settings for large files..."
echo "Node.js memory limit: ${NODE_MEMORY}MB"
echo "Stream buffer size: ${STREAM_BUFFER_SIZE:-64}KB"
echo "Max file size: ${MAX_FILE_SIZE_MB:-15000}MB"

# Start the application with optimized flags
exec node $NODE_FLAGS dist/index.js