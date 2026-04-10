#!/bin/bash
echo "Copying application files to server..."
scp -r ./package.json ./yarn.lock ./tsconfig.json quentinbrooks.com:/root/letterfast-server/
scp -r ./web ./scripts quentinbrooks.com:/root/letterfast-server/

echo "Installing dependencies on server..."
ssh quentinbrooks.com "cd /root/letterfast-server && yarn install"

echo "Restarting server..."
bash local-deploy-server.sh
