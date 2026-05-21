#!/bin/bash

# Always-up wrapper script for letterfast server
# This script runs the server and automatically restarts it if it crashes

# Navigate to the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "Starting letterfast server..."
echo "Script directory: $SCRIPT_DIR"
echo "Port: 8880"
echo "Server will auto-restart on crash"
echo "To stop the server, kill this process or exit the screen session"
echo ""

while true; do
    echo "[$(date)] Starting server..."
    
    # Run the server using yarn typenode
    yarn typenode ./web/server.ts
    
    EXIT_CODE=$?
    echo "[$(date)] Server exited with code $EXIT_CODE"
    echo "Restarting in 3 seconds..."
    sleep 3
done
