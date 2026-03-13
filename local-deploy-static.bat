@echo off
echo Building web files...
call yarn build

echo Copying static files to server...
scp -r ./build-web/* quentinbrooks.com:/root/new-site/dist/letterfast/

echo Static files deployed!
