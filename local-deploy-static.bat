@echo off
echo Building web files...
call yarn build

echo Copying static files to server...
scp ./build-web/browser.js ./build-web/index.html quentinbrooks.com:/root/new-site/dist/letterfast/

echo Static files deployed!
