#!/bin/bash

clear

echo -e "\033[1;33m-----------------------------------------------\033[0m"
echo -e "             \033[1;36mscrcpy-desktop\033[0m"
echo -e "\033[1;33m-----------------------------------------------\033[0m"
echo -e "    \033[1;34mhttps://github.com/serifpersia/scrcpy-desktop\033[0m"
echo -e "\033[1;33m-----------------------------------------------\033[0m"
echo
echo -e "\033[1;32mStarting scrcpy desktop...\033[0m"
echo


if [ ! -d "node_modules" ]; then
    echo -e "\033[1;33mServer dependencies not found. Installing with npm install --omit=dev...\033[0m"
    npm install --omit=dev
    if [ $? -ne 0 ]; then
        echo -e "\033[1;31mError: npm install failed!\033[0m"
        read -p "Press Enter to exit..."
        exit $?
    else
        echo -e "\033[1;32mSuccess: npm install completed!\033[0m"
    fi
else
    echo -e "\033[1;36mFound existing server dependencies (node_modules). Skipping install.\033[0m"
fi
echo

echo -e "\033[1;33mRunning npm start...\033[0m"
npm start
if [ $? -ne 0 ]; then
    echo -e "\033[1;31mError: npm start failed!\033[0m"
    read -p "Press Enter to exit..."
    exit $?
else
    echo -e "\033[1;32mSuccess: npm start completed!\033[0m"
fi

echo
echo -e "\033[1;32mAll commands executed successfully!\033[0m"
echo -e "\033[1;33mscrcpy desktop is now running.\033[0m"
read -p "Press Enter to continue..."
exit 0