#!/bin/bash

echo "Checking for Python 3.9+..."

# Detect OS and set Python command accordingly
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    PYTHON_CMD="python"  # Windows (Git Bash)
else
    PYTHON_CMD="python3"  # Linux/macOS
fi

# Check if Python is installed
if ! command -v $PYTHON_CMD &> /dev/null; then
    echo "Error: Python 3.9+ not found! Please install it and try again."
    exit 1
fi

# Get Python major and minor version
PYTHON_MAJOR=$($PYTHON_CMD -c "import sys; print(sys.version_info[0])")
PYTHON_MINOR=$($PYTHON_CMD -c "import sys; print(sys.version_info[1])")

if [[ $PYTHON_MAJOR -lt 3 || ($PYTHON_MAJOR -eq 3 && $PYTHON_MINOR -lt 9) ]]; then
    echo "Error: Python version must be 3.9 or higher! Found: $PYTHON_MAJOR.$PYTHON_MINOR"
    exit 1
fi

echo "Setting up virtual environment..."
if [ ! -d "venv" ]; then
    $PYTHON_CMD -m venv venv
    echo "Virtual environment created."
fi

echo "Activating virtual environment..."
# Use the correct activation path for each OS
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
    source venv/Scripts/activate  # Windows Git Bash
else
    source venv/bin/activate  # Linux/macOS
fi

echo "Installing dependencies..."
pip install -r requirements.txt

echo "Starting Scrcpy Desktop server..."
$PYTHON_CMD server.py
