#!/bin/bash

# Server-side deployment script for letterfast
# This script manages the screen session and cron job for the server

SCREEN_NAME="letterfast-server"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SCREEN="/usr/bin/screen"
CRON_ENTRY="@reboot $SCREEN -dmS $SCREEN_NAME bash $SCRIPT_DIR/run-server.sh"

echo "====================================="
echo "Letterfast Server Deployment"
echo "====================================="
echo ""

# Debug: Show where we're running
echo "Current directory: $(pwd)"
echo "Hostname: $(hostname)"
echo "Uname: $(uname -a)"
echo "Yarn location: $(which yarn)"
echo ""

# Install dependencies
echo "Installing dependencies..."
yarn install --ignore-platform
echo "✓ Dependencies installed"
echo ""

# Stop existing server if screen session exists
if $SCREEN -list | grep -q "$SCREEN_NAME"; then
    echo "Stopping existing server in screen session: $SCREEN_NAME"
    echo "Sending Ctrl+C (3x) to gracefully stop the server..."
    $SCREEN -S "$SCREEN_NAME" -X stuff "^C"
    sleep 1
    $SCREEN -S "$SCREEN_NAME" -X stuff "^C"
    sleep 1
    $SCREEN -S "$SCREEN_NAME" -X stuff "^C"
    sleep 2
    echo "Server stopped"
else
    echo "No existing screen session found, creating new one..."
    cd "$SCRIPT_DIR"
    $SCREEN -dmS "$SCREEN_NAME" bash -c "./run-server.sh"
    sleep 2
fi

echo ""

# Start server (either in existing or new screen session)
if $SCREEN -list | grep -q "$SCREEN_NAME"; then
    echo "Starting server in existing screen session: $SCREEN_NAME"
    cd "$SCRIPT_DIR"
    $SCREEN -S "$SCREEN_NAME" -X stuff "cd $SCRIPT_DIR && ./run-server.sh\n"
else
    echo "Creating new screen session: $SCREEN_NAME"
    cd "$SCRIPT_DIR"
    $SCREEN -dmS "$SCREEN_NAME" bash -c "./run-server.sh"
fi

sleep 2

# Check if screen started successfully
if $SCREEN -list | grep -q "$SCREEN_NAME"; then
    echo "✓ Screen session started successfully"
    echo "  To attach: screen -r $SCREEN_NAME"
    echo "  To detach: Ctrl+A, then D"
else
    echo "✗ Failed to start screen session"
    exit 1
fi

echo ""

# Update crontab
echo "Updating crontab for auto-start on boot..."

# Check if cron entry already exists
if crontab -l 2>/dev/null | grep -q "$SCREEN_NAME"; then
    echo "Cron entry already exists, updating..."
    # Remove old entry and add new one
    (crontab -l 2>/dev/null | grep -v "$SCREEN_NAME"; echo "$CRON_ENTRY") | crontab -
else
    echo "Adding new cron entry..."
    # Add new entry
    (crontab -l 2>/dev/null; echo "$CRON_ENTRY") | crontab -
fi

# Verify cron entry
if crontab -l 2>/dev/null | grep -q "$SCREEN_NAME"; then
    echo "✓ Cron entry added successfully"
    echo "  Entry: $CRON_ENTRY"
else
    echo "✗ Failed to add cron entry"
    exit 1
fi