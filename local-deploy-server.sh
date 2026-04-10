#!/bin/bash
echo "Copying files to server..."
scp -r ./run-server.sh ./deploy-server.sh ./.yarnrc ./package.json ./yarn.lock ./web ./tsconfig.json quentinbrooks.com:/root/letterfast-server/

echo "Running deployment on server..."
ssh quentinbrooks.com "cd /root/letterfast-server && bash deploy-server.sh"
